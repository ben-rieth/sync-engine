// ASCII-only so string ordering matches across JS, UTF-8 byte order and C collation
const NODE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export const isValidNodeId = (nodeId: string): boolean => NODE_ID_PATTERN.test(nodeId);

export const assertNodeId = (nodeId: string): void => {
  if (!isValidNodeId(nodeId)) {
    throw new RangeError(`Invalid HLC nodeId: ${JSON.stringify(nodeId)}`);
  }
};
