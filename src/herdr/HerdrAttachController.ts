import * as vscode from "vscode";
import type {
  TerminalExitEvent,
  TerminalManager,
} from "../terminals/TerminalManager";
import type {
  TerminalTransport,
  TerminalTransportExitReason,
} from "../terminals/TerminalTransport";

export type SourceStatePhase =
  | "shell"
  | "attaching"
  | "attached"
  | "detaching"
  | "error";

export interface SourceState {
  readonly source: "herdr" | "shell";
  readonly phase: SourceStatePhase;
  readonly label?: string;
  readonly message?: string;
}

export interface HerdrAttachTarget {
  readonly terminalId: string;
  readonly label?: string;
}

export interface TerminalDimensions {
  readonly cols: number;
  readonly rows: number;
}

export interface HerdrAttachManager {
  readonly onExit: vscode.Event<TerminalExitEvent>;
  attach(
    id: string,
    factory: () => TerminalTransport,
    initialReplay?: string,
  ): TerminalTransport;
  detach(id: string): void;
  resize(id: string, cols: number, rows: number): void;
  ensureLocalShell(id: string, cols: number, rows: number): unknown;
  activeSource(id: string): "local-shell" | "herdr-control" | undefined;
  replay(id: string): string;
}

export interface HerdrAttachPresenter {
  postReset(): void;
  postOutput(data: string): void;
  postSourceState(state: SourceState): void;
}

export interface HerdrAttachControllerOptions {
  readonly manager: HerdrAttachManager | TerminalManager;
  readonly terminalId: string;
  readonly transportFactory: (
    target: HerdrAttachTarget,
    dimensions: TerminalDimensions,
  ) => TerminalTransport;
  readonly presenter: HerdrAttachPresenter;
}

export class HerdrAttachBusyError extends Error {
  public constructor() {
    super("A Herdr terminal is already attaching or attached.");
    this.name = "HerdrAttachBusyError";
  }
}

type ControllerPhase = "shell" | "attaching" | "attached" | "detaching";

export class HerdrAttachController implements vscode.Disposable {
  private readonly manager: HerdrAttachManager;
  private readonly terminalId: string;
  private readonly transportFactory: HerdrAttachControllerOptions["transportFactory"];
  private readonly presenter: HerdrAttachPresenter;
  private readonly sourceStateEmitter = new vscode.EventEmitter<SourceState>();
  private phase: ControllerPhase = "shell";
  private dimensions: TerminalDimensions | undefined;
  private label: string | undefined;
  private transport: TerminalTransport | undefined;
  private managedTransport: BufferedAttachTransport | undefined;
  private outputSubscription: vscode.Disposable | undefined;
  private exitSubscription: vscode.Disposable | undefined;
  private managerExitSubscription: vscode.Disposable | undefined;
  private generation = 0;
  private disposed = false;
  private explicitDetach = false;
  private pendingAttachResolve: (() => void) | undefined;

  public readonly onSourceState = this.sourceStateEmitter.event;

  public constructor(options: HerdrAttachControllerOptions) {
    this.manager = options.manager;
    this.terminalId = options.terminalId;
    this.transportFactory = options.transportFactory;
    this.presenter = options.presenter;
  }

  public get sourceState(): SourceState {
    if (this.phase === "attached") {
      return this.withLabel({ source: "herdr", phase: "attached" });
    }
    if (this.phase === "attaching") {
      return this.withLabel({ source: "herdr", phase: "attaching" });
    }
    if (this.phase === "detaching") {
      return { source: "herdr", phase: "detaching" };
    }
    return { source: "shell", phase: "shell" };
  }

  public attach(
    target: HerdrAttachTarget,
    dimensions: TerminalDimensions,
  ): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("Herdr attach controller is disposed."));
    }
    if (this.phase !== "shell") {
      return Promise.reject(new HerdrAttachBusyError());
    }

    this.phase = "attaching";
    this.dimensions = dimensions;
    this.label = target.label;
    const generation = ++this.generation;
    this.emitState(this.withLabel({ source: "herdr", phase: "attaching" }));

    let transport: TerminalTransport;
    try {
      transport = this.transportFactory(target, dimensions);
    } catch (error) {
      this.failBeforeCutover(generation, "spawn-error", errorMessage(error));
      return Promise.resolve();
    }
    this.transport = transport;

    return new Promise<void>((resolve) => {
      this.pendingAttachResolve = resolve;
      this.outputSubscription = transport.onOutput(({ data, replay }) => {
        if (!this.isCurrent(generation, transport)) {
          return;
        }
        if (this.phase === "attaching") {
          if (replay === "replace") {
            this.completeCutover(generation, transport, data);
          }
          return;
        }
        if (this.phase === "attached") {
          this.managedTransport?.emitOutput(data, replay);
        }
      });
      this.exitSubscription = transport.onExit(({ reason, message }) => {
        if (!this.isCurrent(generation, transport) || this.explicitDetach) {
          return;
        }
        queueMicrotask(() => {
          if (!this.isCurrent(generation, transport) || this.explicitDetach) {
            return;
          }
          if (this.phase === "attaching") {
            this.failBeforeCutover(generation, reason, message);
          } else if (this.phase === "attached") {
            this.managedTransport?.emitExit(reason, message);
            void this.restoreAfterExternalExit(generation, reason, message);
          }
        });
      });
    });
  }

  public async detach(): Promise<void> {
    if (this.disposed || this.phase === "shell" || this.phase === "detaching") {
      return;
    }

    const transport = this.managedTransport ?? this.transport;
    const dimensions = this.dimensions;
    const generation = ++this.generation;
    this.phase = "detaching";
    this.explicitDetach = true;
    this.emitState({ source: "herdr", phase: "detaching" });
    this.disposeTransportSubscriptions();
    this.resolvePendingAttach();

    try {
      await transport?.close("release");
    } finally {
      if (this.disposed || generation !== this.generation) {
        return;
      }
      this.manager.detach(this.terminalId);
      this.transport = undefined;
      this.managedTransport = undefined;
      this.explicitDetach = false;
      this.restoreShell(dimensions);
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.generation += 1;
    const transport = this.managedTransport ?? this.transport;
    this.transport = undefined;
    this.managedTransport = undefined;
    this.disposeTransportSubscriptions();
    this.resolvePendingAttach();
    if (transport) {
      void transport.close("release");
      if (this.phase === "attached") {
        this.manager.detach(this.terminalId);
      }
    }
    this.managerExitSubscription?.dispose();
    this.managerExitSubscription = undefined;
    this.sourceStateEmitter.dispose();
  }

  private completeCutover(
    generation: number,
    transport: TerminalTransport,
    fullFrame: string,
  ): void {
    if (!this.isCurrent(generation, transport) || this.phase !== "attaching") {
      return;
    }
    const managedTransport = new BufferedAttachTransport(transport);
    this.managedTransport = managedTransport;
    try {
      this.subscribeToManagerExit(generation);
      this.manager.attach(this.terminalId, () => managedTransport, fullFrame);
    } catch (error) {
      this.failBeforeCutover(generation, "protocol-error", errorMessage(error));
      return;
    }
    if (!this.isCurrent(generation, transport)) {
      return;
    }
    this.presenter.postReset();
    this.presenter.postOutput(fullFrame);
    this.phase = "attached";
    this.emitState(this.withLabel({ source: "herdr", phase: "attached" }));
    this.resolvePendingAttach();
  }

  private failBeforeCutover(
    generation: number,
    reason: TerminalTransportExitReason,
    message?: string,
  ): void {
    if (generation !== this.generation || this.phase !== "attaching") {
      return;
    }
    const transport = this.transport;
    this.generation += 1;
    this.transport = undefined;
    this.managedTransport = undefined;
    this.phase = "shell";
    this.disposeTransportSubscriptions();
    if (transport) {
      void transport.close("release");
    }
    this.emitState({
      source: "shell",
      phase: "error",
      message: message ?? exitMessage(reason),
    });
    this.emitState({ source: "shell", phase: "shell" });
    this.resolvePendingAttach();
  }

  private async restoreAfterExternalExit(
    generation: number,
    reason: TerminalTransportExitReason,
    message?: string,
  ): Promise<void> {
    if (!this.isCurrent(generation, this.transport) || this.phase !== "attached") {
      return;
    }
    const dimensions = this.dimensions;
    this.generation += 1;
    this.transport = undefined;
    this.managedTransport = undefined;
    this.phase = "shell";
    this.disposeTransportSubscriptions();
    this.manager.detach(this.terminalId);
    this.emitState({
      source: "shell",
      phase: "error",
      message: message ?? exitMessage(reason),
    });
    this.restoreShell(dimensions);
  }

  private restoreShell(dimensions: TerminalDimensions | undefined): void {
    let message: string | undefined;
    if (dimensions) {
      if (this.manager.activeSource(this.terminalId) !== "local-shell") {
        this.manager.ensureLocalShell(
          this.terminalId,
          dimensions.cols,
          dimensions.rows,
        );
        message = "Local shell restarted because it exited while Herdr was attached.";
      }
      this.manager.resize(this.terminalId, dimensions.cols, dimensions.rows);
    }
    this.presenter.postReset();
    const replay = this.manager.replay(this.terminalId);
    if (replay.length > 0) {
      this.presenter.postOutput(replay);
    }
    this.phase = "shell";
    this.label = undefined;
    this.emitState(
      message
        ? { source: "shell", phase: "shell", message }
        : { source: "shell", phase: "shell" },
    );
  }

  private emitState(state: SourceState): void {
    if (this.disposed) {
      return;
    }
    this.presenter.postSourceState(state);
    this.sourceStateEmitter.fire(state);
  }

  private withLabel(state: SourceState): SourceState {
    return this.label ? { ...state, label: this.label } : state;
  }

  private isCurrent(
    generation: number,
    transport: TerminalTransport | undefined,
  ): boolean {
    return (
      !this.disposed &&
      generation === this.generation &&
      transport !== undefined &&
      this.transport === transport
    );
  }

  private subscribeToManagerExit(generation: number): void {
    this.managerExitSubscription?.dispose();
    this.managerExitSubscription = this.manager.onExit((event) => {
      if (
        event.id !== this.terminalId ||
        generation !== this.generation ||
        this.phase !== "attached" ||
        this.explicitDetach ||
        this.disposed
      ) {
        return;
      }
      queueMicrotask(() => {
        if (generation !== this.generation || this.phase !== "attached") {
          return;
        }
        void this.restoreAfterExternalExit(
          generation,
          event.reason,
          event.message,
        );
      });
    });
  }

  private disposeTransportSubscriptions(): void {
    this.outputSubscription?.dispose();
    this.exitSubscription?.dispose();
    this.managerExitSubscription?.dispose();
    this.outputSubscription = undefined;
    this.exitSubscription = undefined;
    this.managerExitSubscription = undefined;
  }

  private resolvePendingAttach(): void {
    const resolve = this.pendingAttachResolve;
    this.pendingAttachResolve = undefined;
    resolve?.();
  }
}

class BufferedAttachTransport implements TerminalTransport {
  public readonly kind = "herdr-control" as const;
  private readonly outputEmitter = new vscode.EventEmitter<{
    data: string;
    replay: "append" | "replace";
  }>();
  private readonly exitEmitter = new vscode.EventEmitter<{
    reason: TerminalTransportExitReason;
    message?: string;
  }>();
  public readonly onOutput = this.outputEmitter.event;
  public readonly onExit = this.exitEmitter.event;

  public constructor(private readonly transport: TerminalTransport) {}

  public write(data: string): void {
    this.transport.write(data);
  }

  public resize(cols: number, rows: number): void {
    this.transport.resize(cols, rows);
  }

  public close(reason: "release" | "shutdown"): Promise<void> {
    return this.transport.close(reason);
  }

  public emitOutput(data: string, replay: "append" | "replace"): void {
    this.outputEmitter.fire({ data, replay });
  }

  public emitExit(reason: TerminalTransportExitReason, message?: string): void {
    this.exitEmitter.fire(message ? { reason, message } : { reason });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exitMessage(reason: TerminalTransportExitReason): string {
  switch (reason) {
    case "released":
      return "Herdr terminal control was released externally.";
    case "takeover":
      return "Herdr terminal control was taken over by another controller.";
    case "pane-exited":
      return "The attached Herdr pane exited.";
    case "server-stopped":
      return "The Herdr server stopped.";
    case "protocol-error":
      return "The Herdr terminal control protocol failed.";
    case "spawn-error":
      return "The Herdr terminal control process could not be started.";
    case "timeout":
      return "Herdr did not provide a terminal frame before the timeout.";
    case "process-exit":
      return "The Herdr terminal control process exited.";
  }
}
