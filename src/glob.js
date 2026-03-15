import { normalizeMatchPath } from "./fs-util.js";

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegex(pattern) {
  if (pattern.endsWith("/**")) {
    const basePattern = pattern.slice(0, -3);
    return new RegExp(`^${escapeRegex(basePattern)}(?:/.*)?$`);
  }

  let output = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const next = pattern[index + 1];

    if (character === "*" && next === "*") {
      output += ".*";
      index += 1;
      continue;
    }

    if (character === "*") {
      output += "[^/]*";
      continue;
    }

    if (character === "?") {
      output += "[^/]";
      continue;
    }

    output += escapeRegex(character);
  }

  output += "$";
  return new RegExp(output);
}

export function matchesGlob(pattern, candidate) {
  const regex = globToRegex(pattern);
  return regex.test(candidate);
}

export function matchesAny(patterns, candidate) {
  return patterns.some((pattern) => matchesGlob(pattern, candidate));
}

export function normalizePatternList(patterns) {
  return patterns.map((pattern) => normalizeMatchPath(pattern));
}
