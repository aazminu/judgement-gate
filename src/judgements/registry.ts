import type { Judgement } from "../types";
import { oneWayDoor } from "./one-way-door";

export interface BuiltinOverrides {
  confidence_threshold?: number;
  applies_to?: string[];
}

export interface BuiltinDefaults {
  confidenceThreshold: number;
}

export const BUILTIN_IDS = ["one-way-door"] as const;

export function builtinById(id: string, overrides: BuiltinOverrides, defaults: BuiltinDefaults): Judgement | undefined {
  switch (id) {
    case "one-way-door":
      return oneWayDoor({
        confidenceThreshold: overrides.confidence_threshold ?? defaults.confidenceThreshold,
        appliesTo: overrides.applies_to,
      });
    default:
      return undefined;
  }
}
