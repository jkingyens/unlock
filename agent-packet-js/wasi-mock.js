// A dummy implementation to satisfy any lingering WASI imports
export const poll = {
    poll: () => [] 
};

export const error = {
    error: class {}
};

export const streams = {
    read: () => new Uint8Array([]),
    write: () => 0
};

export const stdin = { getStdin: () => {} };
export const stdout = { getStdout: () => {} };
export const stderr = { getStderr: () => {} };