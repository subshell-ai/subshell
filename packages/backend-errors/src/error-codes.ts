export enum BackendErrorCodes {
  ACCESS_DENIED = "ACCESS_DENIED",
  BAD_REQUEST = "BAD_REQUEST",
  EXISTS_ERROR = "EXISTS_ERROR",
  INPUT_VALIDATION_ERROR = "INPUT_VALIDATION_ERROR",
  INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR",
  INVALID_CREDENTIALS = "INVALID_CREDENTIALS",
  NOT_FOUND_ERROR = "NOT_FOUND_ERROR",
  /**
   * The phase-1 placeholder refusing any non-local `POST /api/sessions` body.
   * Phase 2 removed the gate it served (§6.6 resolution is live); kept so the
   * published enum never churns, and the frontend's phase-1 belt comment still
   * names it. Nothing throws it anymore.
   * @deprecated Superseded by the §6.6 launch-node resolution (NODE_REQUIRED,
   * NODE_OFFLINE, and the plain 403/404s it produces).
   */
  NODE_LAUNCH_NOT_READY = "NODE_LAUNCH_NOT_READY",
  NODE_NAME_TAKEN = "NODE_NAME_TAKEN",
  NODE_OFFLINE = "NODE_OFFLINE",
  NODE_ONLINE = "NODE_ONLINE",
  NODE_REQUIRED = "NODE_REQUIRED",
  NODE_RUNNING_SESSIONS = "NODE_RUNNING_SESSIONS",
  NODE_UNREACHABLE = "NODE_UNREACHABLE",
  SETUP_KEY_CONSUMED = "SETUP_KEY_CONSUMED",
  SETUP_KEY_EXPIRED = "SETUP_KEY_EXPIRED",
  SETUP_KEY_INVALID = "SETUP_KEY_INVALID",
}

export const BackendErrorCodeDefs = {
  [BackendErrorCodes.ACCESS_DENIED]: {
    message: "Access denied",
    statusCode: 403,
  },
  [BackendErrorCodes.BAD_REQUEST]: {
    message: "Bad request",
    statusCode: 400,
  },
  [BackendErrorCodes.EXISTS_ERROR]: {
    message: "Resource already exists",
    statusCode: 409,
  },
  [BackendErrorCodes.INPUT_VALIDATION_ERROR]: {
    message: "Invalid input",
    statusCode: 400,
  },
  [BackendErrorCodes.INTERNAL_SERVER_ERROR]: {
    message: "Internal server error",
    statusCode: 500,
  },
  [BackendErrorCodes.INVALID_CREDENTIALS]: {
    message: "Invalid credentials",
    statusCode: 401,
  },
  [BackendErrorCodes.NOT_FOUND_ERROR]: {
    message: "Resource not found",
    statusCode: 404,
  },
  [BackendErrorCodes.NODE_LAUNCH_NOT_READY]: {
    message: "Remote node launch is not available yet",
    statusCode: 409,
  },
  [BackendErrorCodes.NODE_NAME_TAKEN]: {
    message: "You already have a node with this name",
    statusCode: 409,
  },
  [BackendErrorCodes.NODE_OFFLINE]: {
    message: "Node is offline",
    statusCode: 409,
  },
  [BackendErrorCodes.NODE_ONLINE]: {
    message: "Node is online",
    statusCode: 409,
  },
  [BackendErrorCodes.NODE_REQUIRED]: {
    message: "No launch-eligible node — pick one",
    statusCode: 400,
  },
  [BackendErrorCodes.NODE_RUNNING_SESSIONS]: {
    message: "Node has running sessions",
    statusCode: 409,
  },
  [BackendErrorCodes.NODE_UNREACHABLE]: {
    message: "Node did not respond",
    statusCode: 409,
  },
  [BackendErrorCodes.SETUP_KEY_CONSUMED]: {
    message: "Setup key has already been used",
    statusCode: 401,
  },
  [BackendErrorCodes.SETUP_KEY_EXPIRED]: {
    message: "Setup key has expired",
    statusCode: 401,
  },
  [BackendErrorCodes.SETUP_KEY_INVALID]: {
    message: "Invalid setup key",
    statusCode: 401,
  },
};
