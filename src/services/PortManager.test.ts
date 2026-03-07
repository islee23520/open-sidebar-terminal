import { describe, it, expect, beforeEach } from "vitest";
import { PortManager } from "./PortManager";

describe("PortManager", () => {
  let portManager: PortManager;

  beforeEach(() => {
    portManager = new PortManager();
  });

  describe("getAvailablePort", () => {
    it("should return a port in the valid ephemeral range (16384-65535)", () => {
      const port = portManager.getAvailablePort();

      expect(port).toBeGreaterThanOrEqual(16384);
      expect(port).toBeLessThanOrEqual(65535);
    });

    it("should return different ports on multiple calls", () => {
      const ports = new Set<number>();

      for (let i = 0; i < 100; i++) {
        const port = portManager.getAvailablePort();
        ports.add(port);
        portManager.reservePort(port);
      }

      expect(ports.size).toBe(100);
    });

    it("should throw error when no ports are available", () => {
      const totalPorts = 65535 - 16384 + 1;

      for (let i = 0; i < totalPorts; i++) {
        const port = 16384 + i;
        try {
          portManager.reservePort(port);
        } catch {
          break;
        }
      }

      expect(() => portManager.getAvailablePort()).toThrow(
        "No available ports in range 16384-65535",
      );
    });
  });

  describe("reservePort", () => {
    it("should reserve a specific port", () => {
      const port = 30000;

      portManager.reservePort(port);

      expect(portManager.isPortAvailable(port)).toBe(false);
    });

    it("should throw error for port below minimum range", () => {
      expect(() => portManager.reservePort(16383)).toThrow(
        "Port 16383 is outside valid range 16384-65535",
      );
    });

    it("should throw error for port above maximum range", () => {
      expect(() => portManager.reservePort(65536)).toThrow(
        "Port 65536 is outside valid range 16384-65535",
      );
    });

    it("should throw error when reserving already used port", () => {
      const port = 30000;
      portManager.reservePort(port);

      expect(() => portManager.reservePort(port)).toThrow(
        "Port 30000 is already in use",
      );
    });

    it("should throw error for non-integer ports", () => {
      expect(() => portManager.reservePort(30000.5)).toThrow(
        "Port 30000.5 is outside valid range 16384-65535",
      );
    });
  });

  describe("releasePort", () => {
    it("should release a reserved port", () => {
      const port = 30000;
      portManager.reservePort(port);

      portManager.releasePort(port);

      expect(portManager.isPortAvailable(port)).toBe(true);
    });

    it("should not throw when releasing non-reserved port", () => {
      expect(() => portManager.releasePort(30000)).not.toThrow();
    });

    it("should make released port available for reservation again", () => {
      const port = 30000;
      portManager.reservePort(port);
      portManager.releasePort(port);

      expect(() => portManager.reservePort(port)).not.toThrow();
    });
  });

  describe("getPortForTerminal", () => {
    it("should return undefined for terminal without assigned port", () => {
      const port = portManager.getPortForTerminal("terminal-1");

      expect(port).toBeUndefined();
    });

    it("should return assigned port for terminal", () => {
      portManager.assignPortToTerminal("terminal-1", 30000);

      const port = portManager.getPortForTerminal("terminal-1");

      expect(port).toBe(30000);
    });
  });

  describe("assignPortToTerminal", () => {
    it("should assign a specific port to terminal", () => {
      const port = portManager.assignPortToTerminal("terminal-1", 30000);

      expect(port).toBe(30000);
      expect(portManager.getPortForTerminal("terminal-1")).toBe(30000);
    });

    it("should assign available port when none specified", () => {
      const port = portManager.assignPortToTerminal("terminal-1");

      expect(port).toBeGreaterThanOrEqual(16384);
      expect(port).toBeLessThanOrEqual(65535);
      expect(portManager.getPortForTerminal("terminal-1")).toBe(port);
    });

    it("should return existing port if terminal already has one", () => {
      portManager.assignPortToTerminal("terminal-1", 30000);
      const port = portManager.assignPortToTerminal("terminal-1", 30001);

      expect(port).toBe(30000);
    });

    it("should throw error when assigning already used port", () => {
      portManager.assignPortToTerminal("terminal-1", 30000);

      expect(() =>
        portManager.assignPortToTerminal("terminal-2", 30000),
      ).toThrow("Port 30000 is already in use by another terminal");
    });

    it("should mark port as used after assignment", () => {
      portManager.assignPortToTerminal("terminal-1", 30000);

      expect(portManager.isPortAvailable(30000)).toBe(false);
    });
  });

  describe("releaseTerminalPorts", () => {
    it("should release port assigned to terminal", () => {
      portManager.assignPortToTerminal("terminal-1", 30000);

      portManager.releaseTerminalPorts("terminal-1");

      expect(portManager.getPortForTerminal("terminal-1")).toBeUndefined();
      expect(portManager.isPortAvailable(30000)).toBe(true);
    });

    it("should not throw for terminal without port", () => {
      expect(() =>
        portManager.releaseTerminalPorts("non-existent"),
      ).not.toThrow();
    });

    it("should allow reassignment of released port", () => {
      portManager.assignPortToTerminal("terminal-1", 30000);
      portManager.releaseTerminalPorts("terminal-1");

      expect(() =>
        portManager.assignPortToTerminal("terminal-2", 30000),
      ).not.toThrow();
    });
  });

  describe("allocate", () => {
    it("should allocate a port for a specific tool", () => {
      const port = portManager.allocate("opencode");

      expect(port).toBeGreaterThanOrEqual(16384);
      expect(port).toBeLessThanOrEqual(32767);
      expect(portManager.isPortAvailable(port)).toBe(false);
    });

    it("should allocate different ports for different tools", () => {
      const port1 = portManager.allocate("opencode");
      const port2 = portManager.allocate("claude");

      expect(port1).not.toBe(port2);
      expect(port1).toBeLessThanOrEqual(32767);
      expect(port2).toBeGreaterThanOrEqual(32768);
      expect(port2).toBeLessThanOrEqual(49151);
    });

    it("should fallback to shared range if tool range is full", () => {
      // Fill opencode range (16384-32767)
      // For testing, we can just reserve all ports in that range
      for (let port = 16384; port <= 32767; port++) {
        portManager.reservePort(port);
      }

      // This should now return a port from another range
      const port = portManager.allocate("opencode");
      expect(port).toBeGreaterThan(32767);
    });

    it("should throw error if all ports are full", () => {
      // Fill all ports
      for (let port = 16384; port <= 65535; port++) {
        try {
          portManager.reservePort(port);
        } catch {
          // Ignore if already reserved
        }
      }

      expect(() => portManager.allocate("opencode")).toThrow(
        "No available ports in range 16384-65535",
      );
    });
  });

  describe("release", () => {
    it("should release an allocated port", () => {
      const port = portManager.allocate("opencode");
      portManager.release("opencode", port);

      expect(portManager.isPortAvailable(port)).toBe(true);
    });
  });

  describe("isPortAvailable", () => {
    it("should return true for available port", () => {
      expect(portManager.isPortAvailable(30000)).toBe(true);
    });

    it("should return false for reserved port", () => {
      portManager.reservePort(30000);

      expect(portManager.isPortAvailable(30000)).toBe(false);
    });

    it("should return false for port below range", () => {
      expect(portManager.isPortAvailable(1000)).toBe(false);
    });

    it("should return false for port above range", () => {
      expect(portManager.isPortAvailable(70000)).toBe(false);
    });
  });

  describe("getAvailablePortCount", () => {
    it("should return total available ports initially", () => {
      const count = portManager.getAvailablePortCount();

      expect(count).toBe(65535 - 16384 + 1);
    });

    it("should decrease when ports are reserved", () => {
      const initialCount = portManager.getAvailablePortCount();

      portManager.reservePort(30000);
      portManager.reservePort(30001);

      expect(portManager.getAvailablePortCount()).toBe(initialCount - 2);
    });

    it("should increase when ports are released", () => {
      portManager.reservePort(30000);
      const countAfterReserve = portManager.getAvailablePortCount();

      portManager.releasePort(30000);

      expect(portManager.getAvailablePortCount()).toBe(countAfterReserve + 1);
    });
  });

  describe("getUsedPorts", () => {
    it("should return empty array initially", () => {
      expect(portManager.getUsedPorts()).toEqual([]);
    });

    it("should return all reserved ports", () => {
      portManager.reservePort(30000);
      portManager.reservePort(30001);
      portManager.reservePort(30002);

      const usedPorts = portManager.getUsedPorts();

      expect(usedPorts).toContain(30000);
      expect(usedPorts).toContain(30001);
      expect(usedPorts).toContain(30002);
      expect(usedPorts).toHaveLength(3);
    });
  });

  describe("getTerminalPortMappings", () => {
    it("should return empty map initially", () => {
      expect(portManager.getTerminalPortMappings().size).toBe(0);
    });

    it("should return all terminal-port mappings", () => {
      portManager.assignPortToTerminal("terminal-1", 30000);
      portManager.assignPortToTerminal("terminal-2", 30001);

      const mappings = portManager.getTerminalPortMappings();

      expect(mappings.get("terminal-1")).toBe(30000);
      expect(mappings.get("terminal-2")).toBe(30001);
      expect(mappings.size).toBe(2);
    });
  });

  describe("clear", () => {
    it("should clear all port reservations", () => {
      portManager.reservePort(30000);
      portManager.reservePort(30001);

      portManager.clear();

      expect(portManager.getUsedPorts()).toHaveLength(0);
    });

    it("should clear all terminal mappings", () => {
      portManager.assignPortToTerminal("terminal-1", 30000);
      portManager.assignPortToTerminal("terminal-2", 30001);

      portManager.clear();

      expect(portManager.getTerminalPortMappings().size).toBe(0);
      expect(portManager.getPortForTerminal("terminal-1")).toBeUndefined();
    });

    it("should make all ports available again", () => {
      portManager.reservePort(30000);
      portManager.assignPortToTerminal("terminal-1", 30001);

      portManager.clear();

      expect(portManager.isPortAvailable(30000)).toBe(true);
      expect(portManager.isPortAvailable(30001)).toBe(true);
    });
  });

  describe("collision detection", () => {
    it("should prevent assigning same port to multiple terminals", () => {
      portManager.assignPortToTerminal("terminal-1", 30000);

      expect(() =>
        portManager.assignPortToTerminal("terminal-2", 30000),
      ).toThrow();
    });

    it("should prevent reserving already assigned port", () => {
      portManager.assignPortToTerminal("terminal-1", 30000);

      expect(() => portManager.reservePort(30000)).toThrow();
    });

    it("should allow port reuse after terminal release", () => {
      portManager.assignPortToTerminal("terminal-1", 30000);
      portManager.releaseTerminalPorts("terminal-1");

      expect(() =>
        portManager.assignPortToTerminal("terminal-2", 30000),
      ).not.toThrow();
    });
  });

  describe("port range validation", () => {
    it("should accept ports at minimum boundary (16384)", () => {
      expect(() => portManager.reservePort(16384)).not.toThrow();
    });

    it("should accept ports at maximum boundary (65535)", () => {
      expect(() => portManager.reservePort(65535)).not.toThrow();
    });

    it("should reject ports below minimum", () => {
      expect(() => portManager.reservePort(16383)).toThrow();
    });

    it("should reject ports above maximum", () => {
      expect(() => portManager.reservePort(65536)).toThrow();
    });

    it("should reject negative ports", () => {
      expect(() => portManager.reservePort(-1)).toThrow();
    });

    it("should reject zero", () => {
      expect(() => portManager.reservePort(0)).toThrow();
    });
  });

  describe("multiple terminal management", () => {
    it("should manage ports for multiple terminals independently", () => {
      const port1 = portManager.assignPortToTerminal("terminal-1");
      const port2 = portManager.assignPortToTerminal("terminal-2");
      const port3 = portManager.assignPortToTerminal("terminal-3");

      expect(port1).not.toBe(port2);
      expect(port2).not.toBe(port3);
      expect(portManager.getPortForTerminal("terminal-1")).toBe(port1);
      expect(portManager.getPortForTerminal("terminal-2")).toBe(port2);
      expect(portManager.getPortForTerminal("terminal-3")).toBe(port3);
    });

    it("should release only specified terminal's port", () => {
      portManager.assignPortToTerminal("terminal-1", 30000);
      portManager.assignPortToTerminal("terminal-2", 30001);

      portManager.releaseTerminalPorts("terminal-1");

      expect(portManager.getPortForTerminal("terminal-1")).toBeUndefined();
      expect(portManager.getPortForTerminal("terminal-2")).toBe(30001);
      expect(portManager.isPortAvailable(30000)).toBe(true);
      expect(portManager.isPortAvailable(30001)).toBe(false);
    });
  });
});
