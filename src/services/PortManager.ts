/**
 * Port Management Service
 *
 * Manages ephemeral port allocation for OpenCode CLI HTTP API communication.
 * Port range: 16384-65535 (ephemeral ports)
 *
 * Features:
 * - Random port assignment within valid range
 * - Port collision detection and prevention
 * - Per-terminal port tracking
 * - Automatic cleanup on terminal closure
 * - Coordination with InstanceStore for cross-instance port conflict detection
 */

import type { InstanceStore } from "./InstanceStore";

export class PortManager {
  // Ephemeral port range (16384-65535)
  private static readonly MIN_PORT = 16384;
  private static readonly MAX_PORT = 65535;

  // Tool-specific port ranges
  private static readonly TOOL_RANGES: Record<
    string,
    { min: number; max: number }
  > = {
    opencode: { min: 16384, max: 32767 },
    claude: { min: 32768, max: 49151 },
    codex: { min: 49152, max: 57343 },
    gemini: { min: 57344, max: 61439 },
    aider: { min: 61440, max: 65535 },
  };

  // Track used ports
  private usedPorts: Set<number> = new Set();

  // Track port-to-terminal mapping
  private terminalPortMap: Map<string, number> = new Map();

  // Track port-to-terminal reverse mapping for cleanup
  private portTerminalMap: Map<number, string> = new Map();

  // Reference to InstanceStore for cross-instance port coordination
  private instanceStore?: InstanceStore;

  /**
   * Initialize PortManager with optional InstanceStore for coordination
   * @param instanceStore - Optional InstanceStore for cross-instance port conflict detection
   */
  constructor(instanceStore?: InstanceStore) {
    this.instanceStore = instanceStore;
  }

  /**
   * Get an available random port in the ephemeral range
   * Checks both local tracking and InstanceStore for conflicts
   * @param min - Minimum port in range (inclusive)
   * @param max - Maximum port in range (inclusive)
   * @returns A random available port number
   * @throws Error if no ports are available
   */
  public getAvailablePort(
    min: number = PortManager.MIN_PORT,
    max: number = PortManager.MAX_PORT,
  ): number {
    const availablePorts = this.getAvailablePortCount(min, max);

    if (availablePorts === 0) {
      throw new Error(`No available ports in range ${min}-${max}`);
    }

    // Try random selection first (up to 100 attempts to avoid infinite loop)
    for (let attempt = 0; attempt < 100; attempt++) {
      const port = this.generateRandomPort(min, max);
      if (this.isPortAvailable(port)) {
        return port;
      }
    }

    // Fallback: sequential scan for available port
    for (let port = min; port <= max; port++) {
      if (this.isPortAvailable(port)) {
        return port;
      }
    }

    throw new Error(`No available ports in range ${min}-${max}`);
  }

  /**
   * Reserve a specific port
   * @param port - The port number to reserve
   * @throws Error if port is out of range or already in use
   */
  public reservePort(port: number): void {
    this.validatePort(port);

    if (this.usedPorts.has(port)) {
      throw new Error(`Port ${port} is already in use`);
    }

    this.usedPorts.add(port);
  }

  /**
   * Release a port back to the pool
   * @param port - The port number to release
   */
  public releasePort(port: number): void {
    if (!this.usedPorts.has(port)) {
      return;
    }

    // Remove from used ports
    this.usedPorts.delete(port);

    // Remove terminal mapping if exists
    const terminalId = this.portTerminalMap.get(port);
    if (terminalId) {
      this.terminalPortMap.delete(terminalId);
      this.portTerminalMap.delete(port);
    }
  }

  /**
   * Get or assign a port for a specific terminal
   * @param terminalId - The terminal identifier
   * @returns The assigned port number, or undefined if no port assigned
   */
  public getPortForTerminal(terminalId: string): number | undefined {
    return this.terminalPortMap.get(terminalId);
  }

  /**
   * Assign a port to a terminal
   * @param terminalId - The terminal identifier
   * @param port - The port to assign (if not provided, gets available port)
   * @returns The assigned port number
   * @throws Error if port assignment fails
   */
  public assignPortToTerminal(terminalId: string, port?: number): number {
    // Check if terminal already has a port
    const existingPort = this.terminalPortMap.get(terminalId);
    if (existingPort !== undefined) {
      return existingPort;
    }

    // Get or validate port
    const assignedPort = port ?? this.getAvailablePort();

    if (port !== undefined) {
      // Validate the provided port
      this.validatePort(port);
      if (this.usedPorts.has(port)) {
        throw new Error(`Port ${port} is already in use by another terminal`);
      }
    }

    // Reserve and assign
    this.usedPorts.add(assignedPort);
    this.terminalPortMap.set(terminalId, assignedPort);
    this.portTerminalMap.set(assignedPort, terminalId);

    return assignedPort;
  }

  /**
   * Release all ports associated with a terminal
   * @param terminalId - The terminal identifier
   */
  public releaseTerminalPorts(terminalId: string): void {
    const port = this.terminalPortMap.get(terminalId);

    if (port !== undefined) {
      this.releasePort(port);
    }
  }

  /**
   * Allocate a port for a specific tool
   * @param toolId - Tool identifier (e.g., 'opencode', 'claude')
   * @returns Allocated port number
   */
  public allocate(toolId: string): number {
    const range = PortManager.TOOL_RANGES[toolId] || {
      min: PortManager.MIN_PORT,
      max: PortManager.MAX_PORT,
    };

    // Try to get port in tool-specific range
    try {
      const port = this.getAvailablePort(range.min, range.max);
      this.reservePort(port);
      return port;
    } catch (error) {
      // Fallback to any available port if tool-specific range is full
      if (
        range.min !== PortManager.MIN_PORT ||
        range.max !== PortManager.MAX_PORT
      ) {
        const port = this.getAvailablePort();
        this.reservePort(port);
        return port;
      }
      throw error;
    }
  }

  /**
   * Release a port for a specific tool
   * @param toolId - Tool identifier
   * @param port - Port number to release
   */
  public release(toolId: string, port: number): void {
    // toolId is currently unused but kept for future range-specific logic
    this.releasePort(port);
  }

  /**
   * Check if a port is available (both locally and in InstanceStore)
   * @param port - The port number to check
   * @returns true if port is available in both local tracking and InstanceStore
   */
  public isPortAvailable(port: number): boolean {
    if (!this.isValidPort(port)) {
      return false;
    }
    // Check local tracking AND instance store for conflicts
    return !this.usedPorts.has(port) && !this.isPortClaimedByInstance(port);
  }

  /**
   * Get the count of available ports in a range
   * @param min - Minimum port in range (inclusive)
   * @param max - Maximum port in range (inclusive)
   * @returns Number of available ports
   */
  public getAvailablePortCount(
    min: number = PortManager.MIN_PORT,
    max: number = PortManager.MAX_PORT,
  ): number {
    const totalInRange = max - min + 1;
    let usedInRange = 0;

    for (const port of this.usedPorts) {
      if (port >= min && port <= max) {
        usedInRange++;
      }
    }

    return totalInRange - usedInRange;
  }

  /**
   * Get all currently used ports
   * @returns Array of used port numbers
   */
  public getUsedPorts(): number[] {
    return Array.from(this.usedPorts);
  }

  /**
   * Get all terminal-port mappings
   * @returns Map of terminal IDs to port numbers
   */
  public getTerminalPortMappings(): Map<string, number> {
    return new Map(this.terminalPortMap);
  }

  /**
   * Check if a port is claimed by any instance in InstanceStore
   * @param port - The port number to check
   * @returns true if port is claimed by an instance in the store
   */
  private isPortClaimedByInstance(port: number): boolean {
    if (!this.instanceStore) {
      return false;
    }

    const instances = this.instanceStore.getAll();
    return instances.some((instance) => instance.runtime.port === port);
  }

  /**
   * Clear all port assignments (useful for testing)
   */
  public clear(): void {
    this.usedPorts.clear();
    this.terminalPortMap.clear();
    this.portTerminalMap.clear();
  }

  /**
   * Generate a random port in the valid range
   * @param min - Minimum port in range (inclusive)
   * @param max - Maximum port in range (inclusive)
   * @returns Random port number
   */
  private generateRandomPort(
    min: number = PortManager.MIN_PORT,
    max: number = PortManager.MAX_PORT,
  ): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Validate port is in valid range
   * @param port - Port to validate
   * @throws Error if port is invalid
   */
  private validatePort(port: number): void {
    if (!this.isValidPort(port)) {
      throw new Error(
        `Port ${port} is outside valid range ${PortManager.MIN_PORT}-${PortManager.MAX_PORT}`,
      );
    }
  }

  /**
   * Check if port is in valid range
   * @param port - Port to check
   * @returns true if port is in valid range
   */
  private isValidPort(port: number): boolean {
    return (
      Number.isInteger(port) &&
      port >= PortManager.MIN_PORT &&
      port <= PortManager.MAX_PORT
    );
  }
}

// Export singleton instance
export const portManager = new PortManager();
