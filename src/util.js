export const ts = (value) => Date.parse(value);

export const inWindow = (at, from, until) => ts(from) <= ts(at) && ts(at) <= ts(until);
