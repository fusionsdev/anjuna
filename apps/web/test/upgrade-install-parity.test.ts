import { upgradeInstallId as contractUpgradeInstallId, upgradeRevisionId as contractUpgradeRevisionId, type UpgradeAllCommand } from "@anjuna/contracts";
import { describe, expect, it } from "vitest";
import { upgradeInstallId as factoryUpgradeInstallId, upgradeRevisionId as factoryUpgradeRevisionId } from "../../../workers/factory/src/workflows/upgrade-all.js";

const command: UpgradeAllCommand = {
  from_template_version_id: "tv-1",
  to_template_version_id: "tv-2",
  form_artifact_id: "fa-1",
  canary_brand_id: "canary",
  started_by: "owner",
  started_role: "owner",
};

const brands = ["canary", "ready", "failed", "rolled", "waiting"] as const;

describe("upgrade install-id parity (contracts vs factory)", () => {
  it("derives byte-identical install IDs across the module boundary", async () => {
    for (const brand of brands) {
      const contractId = await contractUpgradeInstallId(command, brand);
      const factoryId = await factoryUpgradeInstallId(
        command.from_template_version_id,
        command.to_template_version_id,
        command.form_artifact_id,
        brand,
        command.started_by,
        command.started_role,
        command.canary_brand_id,
      );
      expect(contractId).toBe(factoryId);
    }
  });

  it("stays byte-identical across every command-identity axis", async () => {
    const variants: UpgradeAllCommand[] = [
      command,
      { ...command, to_template_version_id: "tv-3" },
      { ...command, canary_brand_id: "other-canary" },
      { ...command, started_by: "other-owner" },
      { ...command, from_template_version_id: "tv-0" },
    ];
    for (const cmd of variants) {
      for (const brand of brands) {
        const contractId = await contractUpgradeInstallId(cmd, brand);
        const factoryId = await factoryUpgradeInstallId(
          cmd.from_template_version_id,
          cmd.to_template_version_id,
          cmd.form_artifact_id,
          brand,
          cmd.started_by,
          cmd.started_role,
          cmd.canary_brand_id,
        );
        expect(contractId).toBe(factoryId);
      }
    }
  });

  it("derives byte-identical revision IDs across the module boundary and every identity axis", async () => {
    const variants: UpgradeAllCommand[] = [
      command,
      { ...command, to_template_version_id: "tv-3" },
      { ...command, canary_brand_id: "other-canary" },
      { ...command, started_by: "other-owner" },
      { ...command, from_template_version_id: "tv-0" },
      { ...command, form_artifact_id: "fa-2" },
    ];
    for (const cmd of variants) {
      for (const brand of brands) {
        const factoryId = await factoryUpgradeRevisionId(
          cmd.from_template_version_id, cmd.to_template_version_id, cmd.form_artifact_id, brand, cmd.started_by, cmd.started_role, cmd.canary_brand_id,
        );
        expect(await contractUpgradeRevisionId(cmd, brand)).toBe(factoryId);
      }
    }
  });
});
