export type ActivityKind = "writing" | "reading" | "research" | "terminal";

export const getToolActivity = (name: string): ActivityKind | null => {
  const tool = name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  const words = tool.split(/[^a-z0-9]+/);
  if (words.some((word) => /^(bash|shell|terminal|powershell|exec|execute|command)$/.test(word))) {
    return "terminal";
  }
  if (words.some((word) => /^(web|websearch|webfetch|browser|browse|research|fetch)$/.test(word))) {
    return "research";
  }
  if (words.some((word) => /^(write|writing|edit|multiedit|patch|create|replace|save)$/.test(word))) {
    return "writing";
  }
  if (words.some((word) => /^(read|reading|view|cat|glob|grep|rg|find|list|ls|search)$/.test(word))) {
    return "reading";
  }
  return null;
};
