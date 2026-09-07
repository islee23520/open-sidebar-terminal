import { describe, expect, test } from "vitest";
import { HerdrInvocationResolver } from "./HerdrInvocationResolver";

const platforms = ["darwin", "linux", "win32"] as const;

describe.each(platforms)("HerdrInvocationResolver on %s", (platform) => {
  test("session wins over socketPath and removes inherited socket selection", () => {
    const resolved = HerdrInvocationResolver.resolve({
      executablePath: "/opt/herdr",
      session: "work",
      socketPath: "/explicit/herdr.sock",
      env: { PATH: "/bin", HERDR_SOCKET_PATH: "/inherited/herdr.sock" },
      platform,
    });

    expect(resolved).toEqual({
      command: "/opt/herdr",
      argsPrefix: ["--session", "work"],
      env: { PATH: "/bin" },
      displayEndpoint: "session work",
      warnings: [
        "Herdr session \"work\" is configured; socketPath \"/explicit/herdr.sock\" is ignored.",
      ],
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.argsPrefix)).toBe(true);
    expect(Object.isFrozen(resolved.env)).toBe(true);
    expect(Object.isFrozen(resolved.warnings)).toBe(true);
  });

  test("an explicit socketPath overrides the inherited socket", () => {
    expect(
      HerdrInvocationResolver.resolve({
        executablePath: "herdr-custom",
        session: "",
        socketPath: "/explicit/herdr.sock",
        env: {
          PATH: "/bin",
          HERDR_SOCKET_PATH: "/inherited/herdr.sock",
          OMITTED: undefined,
        },
        platform,
      }),
    ).toEqual({
      command: "herdr-custom",
      argsPrefix: [],
      env: { PATH: "/bin", HERDR_SOCKET_PATH: "/explicit/herdr.sock" },
      displayEndpoint: "socket /explicit/herdr.sock",
      warnings: [],
    });
  });

  test("passes through an inherited socket when no setting selects an endpoint", () => {
    expect(
      HerdrInvocationResolver.resolve({
        executablePath: "",
        session: " ",
        socketPath: undefined,
        env: { HERDR_SOCKET_PATH: "/inherited/herdr.sock" },
        platform,
      }),
    ).toEqual({
      command: "herdr",
      argsPrefix: [],
      env: { HERDR_SOCKET_PATH: "/inherited/herdr.sock" },
      displayEndpoint: "inherited socket /inherited/herdr.sock",
      warnings: [],
    });
  });

  test("uses the herdr default when no endpoint is selected", () => {
    expect(
      HerdrInvocationResolver.resolve({
        executablePath: undefined,
        session: undefined,
        socketPath: "",
        env: { PATH: "/bin" },
        platform,
      }),
    ).toEqual({
      command: "herdr",
      argsPrefix: [],
      env: { PATH: "/bin" },
      displayEndpoint: "herdr default",
      warnings: [],
    });
  });
});

describe("HerdrInvocationResolver ssh forward", () => {
  const forward = { apiSocketPath: "/tmp/f.sock", clientSocketPath: "/tmp/f-client.sock" };

  test("routes the invocation through the forwarded sockets", () => {
    expect(
      HerdrInvocationResolver.resolve({
        executablePath: "/opt/herdr",
        session: "team",
        remoteTarget: "u@h",
        forwardSockets: forward,
        socketPath: "/explicit/herdr.sock",
        env: { PATH: "/bin", HERDR_SOCKET_PATH: "/inherited/herdr.sock" },
        platform: "darwin",
      }),
    ).toEqual({
      command: "/opt/herdr",
      argsPrefix: [],
      env: {
        PATH: "/bin",
        HERDR_SOCKET_PATH: "/tmp/f.sock",
        HERDR_CLIENT_SOCKET_PATH: "/tmp/f-client.sock",
      },
      displayEndpoint: "forward u@h",
      warnings: [
        'Herdr forwarding to "u@h" is active; session "team" is ignored.',
        'Herdr forwarding to "u@h" is active; socketPath "/explicit/herdr.sock" is ignored.',
      ],
    });
  });

  test("uses the forwarded sockets without session or socket settings", () => {
    expect(
      HerdrInvocationResolver.resolve({
        executablePath: "herdr",
        remoteTarget: "u@h",
        forwardSockets: forward,
        env: { PATH: "/bin" },
        platform: "darwin",
      }),
    ).toEqual({
      command: "herdr",
      argsPrefix: [],
      env: {
        PATH: "/bin",
        HERDR_SOCKET_PATH: "/tmp/f.sock",
        HERDR_CLIENT_SOCKET_PATH: "/tmp/f-client.sock",
      },
      displayEndpoint: "forward u@h",
      warnings: [],
    });
  });

  test("ignores incomplete forward sockets and keeps legacy resolution", () => {
    expect(
      HerdrInvocationResolver.resolve({
        executablePath: "herdr",
        remoteTarget: "u@h",
        forwardSockets: { apiSocketPath: "/tmp/f.sock", clientSocketPath: "   " },
        session: "s",
        env: { HERDR_SOCKET_PATH: "/inherited/herdr.sock" },
        platform: "darwin",
      }),
    ).toEqual({
      command: "herdr",
      argsPrefix: ["--session", "s"],
      env: {},
      displayEndpoint: "session s",
      warnings: [],
    });
  });
});

describe("HerdrInvocationResolver PATH", () => {
  test("prepends common bin dirs so GUI VS Code can find herdr", () => {
    const invocation = HerdrInvocationResolver.resolve({
      executablePath: "herdr",
      session: "",
      socketPath: "",
      env: { PATH: "/usr/bin", HOME: "/Users/tester" },
      platform: "darwin",
    });
    expect(invocation.env.PATH.split(":")).toEqual([
      "/Users/tester/.local/bin",
      "/usr/bin",
    ]);
  });
});
