import { getSkill } from "../skills.js";
import type { Tool } from "../types.js";
import { t } from "./i18n.js";

/** Explain the pending action without invoking a tool or expanding skill templates. */
export function permissionPresentation(tool: Tool, input: Record<string, unknown>) {
  const name = tool.name.toLowerCase();
  const description = typeof input.description === "string" ? input.description : tool.description;
  if (["bash", "powershell", "shell"].includes(name)) {
    return {
      header: t("ui.prompt.commandTitle"),
      subtitle: t("ui.prompt.commandSubtitle"),
      description,
    };
  }
  if (name === "skill" && typeof input.skill === "string") {
    return {
      header: t("ui.prompt.skillTitle", { skill: input.skill }),
      subtitle: t("ui.prompt.skillSubtitle"),
      description: getSkill(input.skill)?.description ?? description,
    };
  }
  const labels: Record<string, string> = {
    read: "ui.tool.read",
    write: "ui.tool.write",
    edit: "ui.tool.edit",
    multi_edit: "ui.tool.edit",
    glob: "ui.tool.glob",
    grep: "ui.tool.grep",
    task: "ui.tool.task",
  };
  return {
    header: `${labels[name] ? t(labels[name]!) : tool.name}?`,
    subtitle: undefined,
    description,
  };
}
