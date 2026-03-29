import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ConnectionResolver } from "./ConnectionResolver";
import { InstanceStore, InstanceRecord } from "./InstanceStore";
import {
  InstanceDiscoveryService,
  OpenCodeInstance,
} from "./InstanceDiscoveryService";
import { InstanceController } from "./InstanceController";
import { OpenCodeApiClient } from "./OpenCodeApiClient";

vi.mock("./InstanceDiscoveryService");
vi.mock("./InstanceController");

describe("ConnectionResolver", () => {
  let resolver: ConnectionResolver;
  let mockStore: InstanceStore;
  let mockDiscovery: InstanceDiscoveryService;
  let mockController: InstanceController;
  let mockOutputChannel: vscode.OutputChannel;
  let mockHealthCheck: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock InstanceStore
    mockStore = {
      get: vi.fn(),
      upsert: vi.fn(),
    } as any;

    // Mock InstanceDiscoveryService
    mockDiscovery = {
      discoverInstances: vi.fn(),
    } as any;

    // Mock InstanceController
    mockController = {
      spawn: vi.fn(),
    } as any;

    mockHealthCheck = vi.spyOn(OpenCodeApiClient.prototype, "healthCheck");

    // Mock OutputChannel
    mockOutputChannel = {
      appendLine: vi.fn(),
    } as any;

    resolver = new ConnectionResolver(
      mockStore,
      mockDiscovery,
      mockController,
      mockOutputChannel,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Tier 1: Stored Port Resolution", () => {
    it("should return stored port from runtime when available", async () => {
      const record: InstanceRecord = {
        config: {
          id: "test-instance",
          preferredPort: 4000,
        },
        runtime: {
          port: 4096,
        },
        state: "connected",
      };

      vi.mocked(mockStore.get).mockReturnValue(record);
      mockHealthCheck.mockResolvedValue(true);

      const port = await resolver.resolve("test-instance");

      expect(port).toBe(4096);
      expect(mockHealthCheck).toHaveBeenCalled();
      expect(mockStore.upsert).toHaveBeenCalled();
    });

    it("should return preferred port from config when runtime port unavailable", async () => {
      const record: InstanceRecord = {
        config: {
          id: "test-instance",
          preferredPort: 4097,
        },
        runtime: {},
        state: "disconnected",
      };

      vi.mocked(mockStore.get).mockReturnValue(record);
      mockHealthCheck.mockResolvedValue(true);

      const port = await resolver.resolve("test-instance");

      expect(port).toBe(4097);
      expect(mockHealthCheck).toHaveBeenCalled();
    });

    it("should fallback to Tier 3 when stored port health check fails", async () => {
      const record: InstanceRecord = {
        config: {
          id: "test-instance",
          preferredPort: 4098,
        },
        runtime: {
          port: 4098,
        },
        state: "connected",
      };

      const discoveredInstance: OpenCodeInstance = {
        port: 4099,
        pid: 12345,
        workspacePath: "/test/workspace",
      };

      vi.mocked(mockStore.get).mockReturnValue(record);
      mockHealthCheck
        .mockResolvedValueOnce(false) // Tier 2 fails
        .mockResolvedValueOnce(true); // Tier 3 succeeds
      vi.mocked(mockDiscovery.discoverInstances).mockResolvedValue([
        discoveredInstance,
      ]);

      const port = await resolver.resolve("test-instance");

      expect(port).toBe(4099);
      expect(mockDiscovery.discoverInstances).toHaveBeenCalled();
    });
  });

  describe("Tier 2: Health Check", () => {
    it("should validate stored port with health check", async () => {
      const record: InstanceRecord = {
        config: {
          id: "test-instance",
        },
        runtime: {
          port: 5000,
        },
        state: "connected",
      };

      vi.mocked(mockStore.get).mockReturnValue(record);
      mockHealthCheck.mockResolvedValue(true);

      const port = await resolver.resolve("test-instance");

      expect(port).toBe(5000);
      expect(mockHealthCheck).toHaveBeenCalled();
    });

    it("should proceed to Tier 3 when health check returns false", async () => {
      const record: InstanceRecord = {
        config: {
          id: "test-instance",
        },
        runtime: {
          port: 5001,
        },
        state: "connected",
      };

      vi.mocked(mockStore.get).mockReturnValue(record);
      mockHealthCheck.mockResolvedValue(false);
      vi.mocked(mockDiscovery.discoverInstances).mockResolvedValue([]);
      vi.mocked(mockController.spawn).mockResolvedValue(undefined);

      await resolver.resolve("test-instance");

      expect(mockDiscovery.discoverInstances).toHaveBeenCalled();
      expect(mockController.spawn).toHaveBeenCalled();
    });

    it("should handle health check exception and proceed to next tier", async () => {
      const record: InstanceRecord = {
        config: {
          id: "test-instance",
        },
        runtime: {
          port: 5002,
        },
        state: "connected",
      };

      vi.mocked(mockStore.get).mockReturnValue(record);
      mockHealthCheck.mockRejectedValue(new Error("Connection refused"));
      vi.mocked(mockDiscovery.discoverInstances).mockResolvedValue([]);

      await resolver.resolve("test-instance");

      expect(mockDiscovery.discoverInstances).toHaveBeenCalled();
    });
  });

  describe("Tier 3: Discovery Resolution", () => {
    it("should find instance by workspace match", async () => {
      const record: InstanceRecord = {
        config: {
          id: "test-instance",
          workspaceUri: "/home/user/project",
        },
        runtime: {},
        state: "disconnected",
      };

      const discoveredInstance: OpenCodeInstance = {
        port: 6000,
        pid: 98765,
        workspacePath: "/home/user/project",
      };

      vi.mocked(mockStore.get).mockReturnValue(record);
      vi.mocked(mockDiscovery.discoverInstances).mockResolvedValue([
        discoveredInstance,
      ]);
      mockHealthCheck.mockResolvedValue(true);

      const port = await resolver.resolve("test-instance");

      expect(port).toBe(6000);
      expect(mockDiscovery.discoverInstances).toHaveBeenCalled();
      expect(mockHealthCheck).toHaveBeenCalled();
      expect(mockStore.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          runtime: expect.objectContaining({
            pid: 98765,
            port: 6000,
          }),
        }),
      );
    });

    it("should fail when discovered instances do not match workspace", async () => {
      const record: InstanceRecord = {
        config: {
          id: "test-instance",
          workspaceUri: "/home/user/project1",
        },
        runtime: {},
        state: "disconnected",
      };

      const discoveredInstance: OpenCodeInstance = {
        port: 6001,
        pid: 11111,
        workspacePath: "/home/user/project2",
      };

      vi.mocked(mockStore.get).mockReturnValue(record);
      vi.mocked(mockDiscovery.discoverInstances).mockResolvedValue([
        discoveredInstance,
      ]);

      const port = await resolver.resolve("test-instance");

      expect(port).toBeUndefined();
      expect(mockController.spawn).toHaveBeenCalled();
    });

    it("should fail when no instances are discovered", async () => {
      const record: InstanceRecord = {
        config: {
          id: "test-instance",
          workspaceUri: "/test",
        },
        runtime: {},
        state: "disconnected",
      };

      vi.mocked(mockStore.get).mockReturnValue(record);
      vi.mocked(mockDiscovery.discoverInstances).mockResolvedValue([]);

      const port = await resolver.resolve("test-instance");

      expect(port).toBeUndefined();
      expect(mockController.spawn).toHaveBeenCalled();
    });

    it("should fail when discovered instance fails health check", async () => {
      const record: InstanceRecord = {
        config: {
          id: "test-instance",
          workspaceUri: "/test",
        },
        runtime: {},
        state: "disconnected",
      };

      const discoveredInstance: OpenCodeInstance = {
        port: 6002,
        pid: 22222,
        workspacePath: "/test",
      };

      vi.mocked(mockStore.get).mockReturnValue(record);
      vi.mocked(mockDiscovery.discoverInstances).mockResolvedValue([
        discoveredInstance,
      ]);
      mockHealthCheck.mockResolvedValue(false);

      const port = await resolver.resolve("test-instance");

      expect(port).toBeUndefined();
      expect(mockController.spawn).toHaveBeenCalled();
    });
  });

  describe("Tier 4: Auto-Spawn Resolution", () => {
    it("should spawn instance when all other tiers fail", async () => {
      const record: InstanceRecord = {
        config: {
          id: "test-instance",
        },
        runtime: {},
        state: "disconnected",
      };

      const spawnedRecord: InstanceRecord = {
        ...record,
        runtime: {
          port: 7000,
          pid: 33333,
        },
        state: "connected",
      };

      // First call: resolve gets initial record (no stored port)
      // Second call: after spawn, get updated record with port
      vi.mocked(mockStore.get)
        .mockReturnValueOnce(record)
        .mockReturnValueOnce(spawnedRecord);
      vi.mocked(mockDiscovery.discoverInstances).mockResolvedValue([]);
      vi.mocked(mockController.spawn).mockResolvedValue(undefined);
      mockHealthCheck.mockResolvedValue(true);

      const port = await resolver.resolve("test-instance");

      expect(port).toBe(7000);
      expect(mockController.spawn).toHaveBeenCalledWith("test-instance", {
        preferredPort: undefined,
      });
    });

    it("should fail when spawn completes but no port is recorded", async () => {
      const record: InstanceRecord = {
        config: {
          id: "test-instance",
        },
        runtime: {},
        state: "disconnected",
      };

      vi.mocked(mockStore.get).mockReturnValue(record);
      vi.mocked(mockDiscovery.discoverInstances).mockResolvedValue([]);
      vi.mocked(mockController.spawn).mockResolvedValue(undefined);

      const port = await resolver.resolve("test-instance");

      expect(port).toBeUndefined();
      expect(mockController.spawn).toHaveBeenCalled();
    });

    it("should fail when spawned instance fails health check", async () => {
      const record: InstanceRecord = {
        config: {
          id: "test-instance",
        },
        runtime: {},
        state: "disconnected",
      };

      const spawnedRecord: InstanceRecord = {
        ...record,
        runtime: {
          port: 7001,
        },
        state: "spawning",
      };

      vi.mocked(mockStore.get)
        .mockReturnValueOnce(record)
        .mockReturnValueOnce(spawnedRecord);
      vi.mocked(mockDiscovery.discoverInstances).mockResolvedValue([]);
      vi.mocked(mockController.spawn).mockResolvedValue(undefined);
      mockHealthCheck.mockResolvedValue(false);

      const port = await resolver.resolve("test-instance");

      expect(port).toBeUndefined();
    });

    it("should skip spawn when controller is not provided", async () => {
      const resolverWithoutController = new ConnectionResolver(
        mockStore,
        mockDiscovery,
        undefined, // No controller
        mockOutputChannel,
      );

      const record: InstanceRecord = {
        config: {
          id: "test-instance",
        },
        runtime: {},
        state: "disconnected",
      };

      vi.mocked(mockStore.get).mockReturnValue(record);
      vi.mocked(mockDiscovery.discoverInstances).mockResolvedValue([]);

      const port = await resolverWithoutController.resolve("test-instance");

      expect(port).toBeUndefined();
      expect(mockController.spawn).not.toHaveBeenCalled();
    });
  });

  describe("4-Tier Fallback Strategy", () => {
    it("should try all 4 tiers in order", async () => {
      const record: InstanceRecord = {
        config: {
          id: "test-instance",
        },
        runtime: {},
        state: "disconnected",
      };

      const spawnedRecord: InstanceRecord = {
        ...record,
        runtime: {
          port: 8000,
        },
        state: "connected",
      };

      // Tier 1: No preferred port in config
      vi.mocked(mockStore.get)
        .mockReturnValueOnce(record)
        .mockReturnValueOnce(spawnedRecord);

      // Tier 2: Health check fails (no port to check)
      // Tier 3: Discovery finds nothing
      vi.mocked(mockDiscovery.discoverInstances).mockResolvedValue([]);

      // Tier 4: Auto-spawn succeeds
      vi.mocked(mockController.spawn).mockResolvedValue(undefined);
      mockHealthCheck.mockResolvedValue(true);

      const port = await resolver.resolve("test-instance");

      expect(mockDiscovery.discoverInstances).toHaveBeenCalled();
      expect(mockController.spawn).toHaveBeenCalled();
      expect(port).toBe(8000);
    });

    it("should return undefined when all tiers fail", async () => {
      const record: InstanceRecord = {
        config: {
          id: "test-instance",
        },
        runtime: {},
        state: "disconnected",
      };

      vi.mocked(mockStore.get).mockReturnValue(record);
      vi.mocked(mockDiscovery.discoverInstances).mockResolvedValue([]);
      vi.mocked(mockController.spawn).mockResolvedValue(undefined);

      const port = await resolver.resolve("test-instance");

      expect(port).toBeUndefined();
    });
  });

  describe("pathsMatch Helper", () => {
    it("should match exact paths", () => {
      expect(
        resolver.pathsMatch("/home/user/project", "/home/user/project"),
      ).toBe(true);
    });

    it("should match parent and child paths", () => {
      expect(resolver.pathsMatch("/home/user/project", "/home/user")).toBe(
        true,
      );
      expect(resolver.pathsMatch("/home/user", "/home/user/project")).toBe(
        true,
      );
    });

    it("should not match different paths", () => {
      expect(
        resolver.pathsMatch("/home/user/project1", "/home/user/project2"),
      ).toBe(false);
    });

    it("should normalize paths with backslashes", () => {
      expect(resolver.pathsMatch("C:\\Users\\test", "C:/Users/test")).toBe(
        true,
      );
    });

    it("should handle trailing slashes", () => {
      expect(
        resolver.pathsMatch("/home/user/project/", "/home/user/project"),
      ).toBe(true);
    });

    it("should return false for empty paths", () => {
      expect(resolver.pathsMatch("", "/home/user/project")).toBe(false);
      expect(resolver.pathsMatch("/home/user/project", "")).toBe(false);
      expect(resolver.pathsMatch("", "")).toBe(false);
    });

    it("should be case-insensitive on Windows and macOS", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", {
        value: "darwin",
        writable: true,
      });

      expect(
        resolver.pathsMatch("/Home/User/Project", "/home/user/project"),
      ).toBe(true);

      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        writable: true,
      });
    });
  });

  describe("Workspace Matching", () => {
    it("should find instance by workspace match", async () => {
      const record: InstanceRecord = {
        config: {
          id: "test-instance",
          workspaceUri: "/home/user/project",
        },
        runtime: {},
        state: "disconnected",
      };

      const discoveredInstances: OpenCodeInstance[] = [
        {
          port: 9000,
          pid: 44444,
          workspacePath: "/home/user/other",
        },
        {
          port: 9001,
          pid: 55555,
          workspacePath: "/home/user/project",
        },
      ];

      vi.mocked(mockStore.get).mockReturnValue(record);
      vi.mocked(mockDiscovery.discoverInstances).mockResolvedValue(
        discoveredInstances,
      );
      mockHealthCheck.mockResolvedValue(true);

      const port = await resolver.resolve("test-instance");

      expect(port).toBe(9001);
      expect(mockStore.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          runtime: expect.objectContaining({
            pid: 55555,
            port: 9001,
          }),
        }),
      );
    });

    it("should match workspace with parent-child relationship", async () => {
      const record: InstanceRecord = {
        config: {
          id: "test-instance",
          workspaceUri: "/home/user/project",
        },
        runtime: {},
        state: "disconnected",
      };

      const discoveredInstance: OpenCodeInstance = {
        port: 9002,
        pid: 66666,
        workspacePath: "/home/user/project/sub",
      };

      vi.mocked(mockStore.get).mockReturnValue(record);
      vi.mocked(mockDiscovery.discoverInstances).mockResolvedValue([
        discoveredInstance,
      ]);
      mockHealthCheck.mockResolvedValue(true);

      const port = await resolver.resolve("test-instance");

      expect(port).toBe(9002);
    });

    it("should use first discovered instance when no workspace is configured", async () => {
      vi.spyOn(vscode.workspace, "workspaceFolders", "get").mockReturnValue(
        undefined,
      );

      const record: InstanceRecord = {
        config: {
          id: "test-instance",
        },
        runtime: {},
        state: "disconnected",
      };

      const discoveredInstances: OpenCodeInstance[] = [
        {
          port: 9003,
          pid: 77777,
          workspacePath: "/some/path",
        },
        {
          port: 9004,
          pid: 88888,
          workspacePath: "/other/path",
        },
      ];

      vi.mocked(mockStore.get).mockReturnValue(record);
      vi.mocked(mockDiscovery.discoverInstances).mockResolvedValue(
        discoveredInstances,
      );
      mockHealthCheck.mockResolvedValue(true);

      const port = await resolver.resolve("test-instance");

      expect(port).toBe(9003);
    });
  });
});
