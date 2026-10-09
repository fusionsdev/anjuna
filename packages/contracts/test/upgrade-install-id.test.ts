import { describe, expect, it } from "vitest";
import { upgradeInstallId, type UpgradeAllCommand } from "../src/index.js";

const command: UpgradeAllCommand = {
  from_template_version_id: "tv-1",
  to_template_version_id: "tv-2",
  form_artifact_id: "fa-1",
  canary_brand_id: "canary",
  started_by: "owner",
  started_role: "owner",
};

describe("upgrade-install identity", () => {
  it("matches the factory workflow's install IDs byte-for-byte", async () => {
    expect(await upgradeInstallId(command, "canary")).toBe("upgrade-install-4821f33d87fbe3a926e33d27ce11eb90200c903a3108e86445724af83a4fbe4e");
    expect(await upgradeInstallId(command, "ready")).toBe("upgrade-install-c13d141f3a9824a0727962834b6b112c09c9dce966053b74539efedfdd4f3def");
    expect(await upgradeInstallId(command, "failed")).toBe("upgrade-install-82cc1ea38f83da792a9c4e857ae297ac141c889b6be5eb700fe36a13b241ff15");
    expect(await upgradeInstallId(command, "rolled")).toBe("upgrade-install-10c95474c750a5af1c2b08652ffa67f77a3f39d5e3f508700de510db11533194");
  });

  it("derives each brand from the full command identity, not just the target", async () => {
    expect(await upgradeInstallId(command, "ready")).not.toBe(await upgradeInstallId(command, "failed"));
    expect(await upgradeInstallId(command, "ready")).not.toBe(await upgradeInstallId({ ...command, to_template_version_id: "tv-3" }, "ready"));
    expect(await upgradeInstallId(command, "ready")).not.toBe(await upgradeInstallId({ ...command, canary_brand_id: "waiting" }, "ready"));
    expect(await upgradeInstallId(command, "ready")).not.toBe(await upgradeInstallId({ ...command, started_by: "other-owner" }, "ready"));
  });
});