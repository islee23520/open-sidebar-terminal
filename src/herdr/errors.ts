export abstract class HerdrError extends Error {
  public readonly displayEndpoint: string;
  public readonly cause?: unknown;

  protected constructor(
    message: string,
    displayEndpoint: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    this.displayEndpoint = displayEndpoint;
    this.cause = cause;
  }
}

export class HerdrNotInstalledError extends HerdrError {
  public constructor(
    displayEndpoint: string,
    executable: string,
    cause?: unknown,
  ) {
    super(
      `Herdr executable \"${executable}\" was not found for ${displayEndpoint}.`,
      displayEndpoint,
      cause,
    );
  }
}

export class HerdrUnsupportedVersionError extends HerdrError {
  public readonly version: string;

  public constructor(displayEndpoint: string, version: string) {
    super(
      `Herdr ${version} at ${displayEndpoint} is unsupported; version 0.8.0 or newer is required.`,
      displayEndpoint,
    );
    this.version = version;
  }
}

export class HerdrServerDownError extends HerdrError {
  public constructor(
    displayEndpoint: string,
    detail: string,
    cause?: unknown,
  ) {
    super(
      `Herdr is unavailable at ${displayEndpoint}${detail ? `: ${detail}` : "."}`,
      displayEndpoint,
      cause,
    );
  }
}

export class HerdrProtocolError extends HerdrError {
  public constructor(
    displayEndpoint: string,
    detail: string,
    cause?: unknown,
  ) {
    super(
      `Herdr returned an invalid response from ${displayEndpoint}: ${detail}`,
      displayEndpoint,
      cause,
    );
  }
}
