import { z } from "zod";
import { readSettings, readSettingsFileStrict } from "./settings.js";
import { settingsWriteTarget } from "./settings-target.js";
import { atomicWriteFile, withFileLock } from "./utils/file-lock.js";

export const LOOP_PROFILES = {
  collaborative: { name: "Collaborative", description: "Verified iterations with human guidance." },
  autonomous: {
    name: "Autonomous",
    description: "Independent engineering work with checks and recovery.",
  },
  scheduled: {
    name: "Scheduled",
    description: "Recurring checks on a fixed schedule until stopped.",
  },
  conservative: { name: "Conservative", description: "Limited iterations with detailed feedback." },
} as const;
export type LoopProfile = keyof typeof LOOP_PROFILES;

export const loopConfigSchema = z
  .object({
    profile: z.enum(["collaborative", "autonomous", "scheduled", "conservative"]),
    cadence: z.enum(["adaptive", "fixed"]),
    intervalMinutes: z.number().int().min(3).max(30),
    maxRounds: z.number().int().min(1).max(1000).nullable(),
    tokenBudget: z.number().int().min(0).max(1_000_000_000),
    usdBudget: z.number().min(0).max(10000),
    inputPrice: z.number().min(0).max(10000).nullable(),
    outputPrice: z.number().min(0).max(10000).nullable(),
    completion: z.enum(["model", "checks", "hybrid", "continuous"]),
    commands: z.array(z.string().trim().min(1).max(4000)).max(10),
    files: z.array(z.string().trim().min(1).max(1000)).max(20),
    retryLimit: z.number().int().min(0).max(10),
    notifications: z.enum(["important", "changes", "all"]),
    historyLimit: z.number().int().min(10).max(1000),
    recovery: z.enum(["confirm", "auto", "manual"]),
    missedRun: z.enum(["skip", "once", "confirm"]),
    timezone: z.string().refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, "Invalid time zone"),
    workHours: z.boolean(),
    startHour: z.number().int().min(0).max(23),
    endHour: z.number().int().min(0).max(23),
    weekdaysOnly: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.profile !== "scheduled" && value.maxRounds === null)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxRounds"],
        message: "Only Scheduled supports continuous rounds.",
      });
  });
export type LoopConfig = z.infer<typeof loopConfigSchema>;

export function defaultLoopConfig(profile: LoopProfile = "collaborative"): LoopConfig {
  return {
    profile,
    cadence: profile === "scheduled" || profile === "conservative" ? "fixed" : "adaptive",
    intervalMinutes: profile === "scheduled" ? 10 : 3,
    maxRounds:
      profile === "scheduled"
        ? null
        : profile === "autonomous"
          ? 30
          : profile === "conservative"
            ? 3
            : 10,
    tokenBudget:
      profile === "conservative" ? 200000 : profile === "collaborative" ? 1000000 : 3000000,
    usdBudget: 0,
    inputPrice: null,
    outputPrice: null,
    completion:
      profile === "scheduled" ? "continuous" : profile === "autonomous" ? "hybrid" : "model",
    commands: [],
    files: [],
    retryLimit: profile === "conservative" ? 1 : 3,
    notifications:
      profile === "conservative" ? "all" : profile === "scheduled" ? "changes" : "important",
    historyLimit: 100,
    recovery: "confirm",
    missedRun: "skip",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    workHours: false,
    startHour: 9,
    endHour: 18,
    weekdaysOnly: false,
  };
}

function section(root: string): Record<string, unknown> {
  const raw = readSettings(root).loop;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}
export function selectedLoopProfile(root: string): LoopProfile {
  const selected = section(root).selectedProfile;
  return typeof selected === "string" && Object.hasOwn(LOOP_PROFILES, selected)
    ? (selected as LoopProfile)
    : "collaborative";
}
export function loopConfig(root: string, profile = selectedLoopProfile(root)): LoopConfig {
  const raw = section(root).profiles;
  const partial =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)[profile]
      : undefined;
  const defaults = defaultLoopConfig(profile);
  const fields = partial && typeof partial === "object" ? (partial as Record<string, unknown>) : {};
  const lines = (value: string) =>
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  const parsed = loopConfigSchema.safeParse({
    ...defaults,
    ...fields,
    ...(typeof fields.commandText === "string" ? { commands: lines(fields.commandText) } : {}),
    ...(typeof fields.fileText === "string" ? { files: lines(fields.fileText) } : {}),
    profile,
  });
  const result = parsed.success ? parsed.data : defaults;
  if (profile === "scheduled") {
    result.cadence = "fixed";
    result.maxRounds = null;
    result.completion = "continuous";
  }
  return result;
}
export function normalizeLoopConfig(config: LoopConfig): LoopConfig {
  const parsed = loopConfigSchema.parse(config);
  if (parsed.profile === "scheduled") {
    parsed.cadence = "fixed";
    parsed.maxRounds = null;
    parsed.completion = "continuous";
  }
  return parsed;
}
export function persistLoopConfig(
  root: string,
  profile: LoopProfile,
  partial: Partial<LoopConfig> = {},
): LoopConfig {
  const next = loopConfigSchema.parse({ ...loopConfig(root, profile), ...partial, profile });
  if (profile === "scheduled") {
    next.cadence = "fixed";
    next.maxRounds = null;
    next.completion = "continuous";
  }
  const target = settingsWriteTarget(root, "loop");
  withFileLock(target.file, () => {
    const { value, corrupt } = readSettingsFileStrict(target.file);
    if (corrupt) throw new Error("Loop settings were not saved: settings.json is invalid.");
    const previous =
      value.loop && typeof value.loop === "object" ? (value.loop as Record<string, unknown>) : {};
    const profiles =
      previous.profiles && typeof previous.profiles === "object"
        ? (previous.profiles as Record<string, unknown>)
        : {};
    value.loop = {
      ...previous,
      selectedProfile: profile,
      profiles: {
        ...profiles,
        [profile]: {
          ...next,
          commands: undefined,
          files: undefined,
          commandText: next.commands.join("\n"),
          fileText: next.files.join("\n"),
        },
      },
    };
    atomicWriteFile(target.file, `${JSON.stringify(value, null, 2)}\n`);
  });
  return next;
}
