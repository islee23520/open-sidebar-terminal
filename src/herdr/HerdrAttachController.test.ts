import * as vscode from "vscode";
import { describe, expect, test, vi } from "vitest";
import {
  TerminalManager,
  type TerminalExitEvent,
} from "../terminals/TerminalManager";
import type {
  TerminalTransport,
  TerminalTransportExitReason,
} from "../terminals/TerminalTransport";
import {
  HerdrAttachController,
  HerdrAttachBusyError,
  type HerdrAttachManager,
  type HerdrAttachPresenter,
  type SourceState,
} from "./HerdrAttachController";

class FakeTransport implements TerminalTransport {
  public readonly kind = "herdr-control" as const;
  private readonly outputEmitter = new vscode.EventEmitter<{
    data: string;
    replay: "append" | "replace";
  }>();
  private readonly exitEmitter = new vscode.EventEmitter<{
    reason: TerminalTransportExitReason;
    message?: string;
  }>();
  public readonly onOutput: TerminalTransport["onOutput"] = (listener) => {
    this.log.push("subscribe");
    return this.outputEmitter.event(listener);
  };
  public readonly onExit = this.exitEmitter.event;
  public readonly write = vi.fn();
  public readonly resize = vi.fn();
  public readonly close = vi.fn(
    async (_reason: "release" | "shutdown"): Promise<void> => undefined,
  );

  public constructor(private readonly log: string[]) {}

  public output(data: string, replay: "append" | "replace"): void {
    this.log.push(replay === "replace" ? "buffer" : "delta");
    this.outputEmitter.fire({ data, replay });
  }

  public exit(reason: TerminalTransportExitReason, message?: string): void {
    this.exitEmitter.fire(message ? { reason, message } : { reason });
  }
}

class FakeManager implements HerdrAttachManager {
  private readonly exitEmitter = new vscode.EventEmitter<TerminalExitEvent>();
  public readonly onExit = this.exitEmitter.event;
  public source: "local-shell" | "herdr-control" | undefined = "local-shell";
  public shellReplay = "shell replay";
  public shellAlive = true;
  public readonly attach = vi.fn((
    id: string,
    factory: () => TerminalTransport,
    _initialReplay?: string,
  ) => {
    this.log.push(`manager.attach:${id}`);
    const transport = factory();
    this.source = "herdr-control";
    transport.onExit(({ reason, message }) => {
      if (this.source === "herdr-control") {
        this.source = this.shellAlive ? "local-shell" : undefined;
        const event = { id, code: 0 } as TerminalExitEvent;
        Object.defineProperties(event, {
          reason: { value: reason, enumerable: false },
          message: { value: message, enumerable: false },
        });
        this.exitEmitter.fire(event);
      }
    });
    return transport;
  });
  public readonly detach = vi.fn((_id: string) => {
    this.log.push("manager.detach");
    this.source = this.shellAlive ? "local-shell" : undefined;
  });
  public readonly resize = vi.fn((_id: string, cols: number, rows: number) => {
    this.log.push(`manager.resize:${cols}x${rows}`);
  });
  public readonly ensureLocalShell = vi.fn((_id: string, _cols: number, _rows: number) => {
    this.log.push("manager.ensureLocalShell");
    this.shellAlive = true;
    this.source = "local-shell";
    return {};
  });
  public readonly activeSource = vi.fn((_id: string) => this.source);
  public readonly replay = vi.fn((_id: string) => this.shellReplay);

  public constructor(private readonly log: string[]) {}
}

class FakePresenter implements HerdrAttachPresenter {
  public readonly states: SourceState[] = [];
  public readonly resets: number[] = [];
  public readonly output: string[] = [];

  public constructor(private readonly log: string[]) {}

  public postReset(): void {
    this.resets.push(this.resets.length + 1);
    this.log.push("presenter.reset");
  }

  public postOutput(data: string): void {
    this.output.push(data);
    this.log.push(`presenter.output:${data}`);
  }

  public postSourceState(state: SourceState): void {
    this.states.push(state);
    this.log.push(`state:${state.phase}`);
  }
}

interface Harness {
  readonly log: string[];
  readonly manager: FakeManager;
  readonly presenter: FakePresenter;
  readonly transports: FakeTransport[];
  readonly controller: HerdrAttachController;
  readonly eventStates: SourceState[];
}

function setup(): Harness {
  const log: string[] = [];
  const manager = new FakeManager(log);
  const presenter = new FakePresenter(log);
  const transports: FakeTransport[] = [];
  const controller = new HerdrAttachController({
    manager,
    terminalId: "sidebar-shell",
    transportFactory: () => {
      const transport = new FakeTransport(log);
      transports.push(transport);
      return transport;
    },
    presenter,
  });
  const eventStates: SourceState[] = [];
  controller.onSourceState((state) => eventStates.push(state));
  return { log, manager, presenter, transports, controller, eventStates };
}

async function attachSuccessfully(harness: Harness, label = "Agent A"): Promise<FakeTransport> {
  const attaching = harness.controller.attach(
    { terminalId: "herdr-terminal", label },
    { cols: 80, rows: 24 },
  );
  const transport = harness.transports[0];
  transport.output("FULL", "replace");
  await attaching;
  return transport;
}

function phases(harness: Harness): string[] {
  return harness.eventStates.map((state) => state.phase);
}

function last<T>(values: readonly T[]): T | undefined {
  return values[values.length - 1];
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("HerdrAttachController", () => {
  test("cuts over atomically after the buffered full frame", async () => {
    const harness = setup();
    const attaching = harness.controller.attach(
      { terminalId: "herdr-terminal", label: "Agent A" },
      { cols: 100, rows: 30 },
    );

    expect(harness.manager.source).toBe("local-shell");
    expect(harness.log).toEqual(["state:attaching", "subscribe"]);

    harness.transports[0].output("FULL FRAME", "replace");
    await attaching;

    expect(harness.log).toEqual([
      "state:attaching",
      "subscribe",
      "buffer",
      "manager.attach:sidebar-shell",
      "presenter.reset",
      "presenter.output:FULL FRAME",
      "state:attached",
    ]);
    expect(last(harness.presenter.states)).toEqual({
      source: "herdr",
      phase: "attached",
      label: "Agent A",
    });
    expect(harness.manager.ensureLocalShell).not.toHaveBeenCalled();
  });

  const preFrameReasons: TerminalTransportExitReason[] = [
    "spawn-error",
    "timeout",
    "protocol-error",
  ];
  test.each(preFrameReasons)(
    "row 2: pre-first-frame %s leaves the shell display untouched",
    async (reason) => {
      const harness = setup();
      const attaching = harness.controller.attach(
        { terminalId: "herdr-terminal" },
        { cols: 80, rows: 24 },
      );
      harness.transports[0].exit(reason, `${reason} detail`);
      await attaching;

      expect(harness.presenter.resets).toEqual([]);
      expect(harness.presenter.output).toEqual([]);
      expect(harness.manager.attach).not.toHaveBeenCalled();
      expect(harness.manager.source).toBe("local-shell");
      expect(harness.transports[0].close).toHaveBeenCalledWith("release");
      expect(phases(harness)).toEqual(["attaching", "error", "shell"]);
      expect(harness.eventStates.filter((state) => state.phase === "error")).toEqual([
        { source: "shell", phase: "error", message: `${reason} detail` },
      ]);
    },
  );

  test("row 3: explicit detach awaits release and restores retained shell replay", async () => {
    const harness = setup();
    const transport = await attachSuccessfully(harness);
    const release = deferred();
    transport.close.mockImplementationOnce(() => release.promise);

    const detaching = harness.controller.detach();
    expect(last(phases(harness))).toBe("detaching");
    expect(harness.manager.detach).not.toHaveBeenCalled();
    release.resolve();
    await detaching;

    expect(transport.close).toHaveBeenCalledWith("release");
    expect(harness.manager.detach).toHaveBeenCalledWith("sidebar-shell");
    expect(harness.manager.resize).toHaveBeenCalledWith("sidebar-shell", 80, 24);
    expect(last(harness.presenter.output)).toBe("shell replay");
    expect(last(phases(harness))).toBe("shell");
    expect(last(harness.eventStates)).toEqual({ source: "shell", phase: "shell" });
  });

  const externalRows: Array<{
    row: number;
    name: string;
    reason: TerminalTransportExitReason;
    message?: string;
    expectedMessage: string;
  }> = [
    {
      row: 4,
      name: "takeover",
      reason: "takeover",
      expectedMessage: "Herdr terminal control was taken over by another controller.",
    },
    {
      row: 5,
      name: "pane exit",
      reason: "pane-exited",
      expectedMessage: "The attached Herdr pane exited.",
    },
    {
      row: 6,
      name: "server stop",
      reason: "server-stopped",
      expectedMessage: "The Herdr server stopped.",
    },
    {
      row: 7,
      name: "protocol/oversize",
      reason: "protocol-error",
      message: "8 MiB exceeded",
      expectedMessage: "8 MiB exceeded",
    },
    {
      row: 7,
      name: "released externally",
      reason: "released",
      expectedMessage: "Herdr terminal control was released externally.",
    },
    {
      row: 7,
      name: "process exit",
      reason: "process-exit",
      expectedMessage: "The Herdr terminal control process exited.",
    },
  ];
  test.each(externalRows)(
    "row $row: $name restores shell for typed lifecycle failure",
    async ({ reason, message, expectedMessage }) => {
      const harness = setup();
      const transport = await attachSuccessfully(harness);
      transport.exit(reason, message);
      await Promise.resolve();

      const errorStates = harness.eventStates.filter((state) => state.phase === "error");
      expect(errorStates).toHaveLength(1);
      expect(errorStates[0].message).toBe(expectedMessage);
      expect(phases(harness).slice(-2)).toEqual(["error", "shell"]);
      expect(harness.manager.detach).toHaveBeenCalledTimes(1);
      expect(last(harness.presenter.output)).toBe("shell replay");

      transport.output("STALE", "append");
      expect(harness.presenter.output).not.toContain("STALE");
      expect(harness.manager.detach).toHaveBeenCalledTimes(1);
    },
  );

  test("row 8: shell exit while attached creates a fresh shell on detach", async () => {
    const harness = setup();
    await attachSuccessfully(harness);
    harness.manager.shellAlive = false;

    await harness.controller.detach();

    expect(harness.manager.ensureLocalShell).toHaveBeenCalledWith(
      "sidebar-shell",
      80,
      24,
    );
    expect(last(harness.eventStates)).toEqual({
      source: "shell",
      phase: "shell",
      message: "Local shell restarted because it exited while Herdr was attached.",
    });
  });

  test("row 9: rejects a double attach while attaching or attached", async () => {
    const harness = setup();
    const first = harness.controller.attach(
      { terminalId: "one" },
      { cols: 80, rows: 24 },
    );
    await expect(
      harness.controller.attach({ terminalId: "two" }, { cols: 80, rows: 24 }),
    ).rejects.toBeInstanceOf(HerdrAttachBusyError);

    harness.transports[0].output("FULL", "replace");
    await first;
    await expect(
      harness.controller.attach({ terminalId: "three" }, { cols: 80, rows: 24 }),
    ).rejects.toBeInstanceOf(HerdrAttachBusyError);
    expect(harness.transports).toHaveLength(1);
  });

  test("real manager seeds the buffered full frame without leaking it to live output", async () => {
    const log: string[] = [];
    const manager = new TerminalManager();
    const presenter = new FakePresenter(log);
    const transport = new FakeTransport(log);
    const managerData: string[] = [];
    manager.onData(({ data }) => {
      managerData.push(data);
      log.push(`manager.data:${data}`);
    });
    const realAttach = manager.attach.bind(manager);
    vi.spyOn(manager, "attach").mockImplementation(
      (id, factory, initialReplay) => {
        log.push("manager.attach");
        return realAttach(id, factory, initialReplay);
      },
    );
    const controller = new HerdrAttachController({
      manager,
      terminalId: "sidebar-shell",
      transportFactory: () => transport,
      presenter,
    });

    const attaching = controller.attach(
      { terminalId: "herdr-terminal" },
      { cols: 80, rows: 24 },
    );
    transport.output("FULL", "replace");
    await attaching;
    transport.output("DELTA", "append");

    expect(presenter.output).toEqual(["FULL"]);
    expect(managerData).toEqual(["DELTA"]);
    expect(log).toEqual([
      "state:attaching",
      "subscribe",
      "buffer",
      "manager.attach",
      "presenter.reset",
      "presenter.output:FULL",
      "state:attached",
      "delta",
      "manager.data:DELTA",
    ]);
    expect(manager.replay("sidebar-shell")).toBe("FULLDELTA");
    controller.dispose();
    manager.dispose();
  });

  test("real manager replay overflow emits one error and restores the shell", async () => {
    const log: string[] = [];
    const manager = new TerminalManager();
    manager.ensureLocalShell("sidebar-shell", 80, 24);
    const presenter = new FakePresenter(log);
    const transport = new FakeTransport(log);
    const states: SourceState[] = [];
    const managerData: string[] = [];
    manager.onData(({ data }) => managerData.push(data));
    const controller = new HerdrAttachController({
      manager,
      terminalId: "sidebar-shell",
      transportFactory: () => transport,
      presenter,
    });
    controller.onSourceState((state) => states.push(state));

    const attaching = controller.attach(
      { terminalId: "herdr-terminal" },
      { cols: 80, rows: 24 },
    );
    transport.output("FULL", "replace");
    await attaching;
    transport.output("x".repeat(8 * 1024 * 1024 + 1), "append");
    await Promise.resolve();

    expect(states.filter((state) => state.phase === "error")).toEqual([
      {
        source: "shell",
        phase: "error",
        message: "Attached terminal replay exceeded the 8 MiB limit.",
      },
    ]);
    expect(last(states)).toEqual({ source: "shell", phase: "shell" });
    expect(manager.activeSource("sidebar-shell")).toBe("local-shell");
    expect(managerData).toEqual([]);
    transport.output("STALE", "append");
    expect(managerData).toEqual([]);
    controller.dispose();
    manager.dispose();
  });

  test.each(["attaching", "attached"] as const)(
    "row 10: dispose during %s is idempotent and suppresses stale events",
    async (phase) => {
      const harness = setup();
      const attaching = harness.controller.attach(
        { terminalId: "herdr-terminal" },
        { cols: 80, rows: 24 },
      );
      const transport = harness.transports[0];
      if (phase === "attached") {
        transport.output("FULL", "replace");
        await attaching;
      }
      const hangingClose = deferred();
      transport.close.mockImplementation(() => hangingClose.promise);

      expect(() => {
        harness.controller.dispose();
        harness.controller.dispose();
      }).not.toThrow();
      expect(transport.close).toHaveBeenCalledTimes(1);
      expect(transport.close).toHaveBeenCalledWith("release");

      transport.output("STALE", "replace");
      transport.exit("takeover");
      expect(harness.eventStates.some((state) => state.phase === "error")).toBe(false);
      hangingClose.resolve();
      await expect(attaching).resolves.toBeUndefined();
    },
  );
});
