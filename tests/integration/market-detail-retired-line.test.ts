/**
 * A line the provider retired (Total 47.5 -> 48.5) must not 404 for the people who made Picks on it: the market page stays reachable, presented as closed
 * and read-only, and the graded-Pick notification link resolves to it. A retired line nobody picked stays unreachable.
 */
import { describe, expect, it } from "vitest";
import { getTestAdminClient } from "./helpers/test-env";
import { seedGame, seedPick, seedUser } from "./helpers/game-seed";
import { getMarketDetail } from "@/lib/prediction-markets/discovery/repository";
import { resolveNotificationHref } from "@/lib/notifications/links";

const admin = getTestAdminClient();

describe("retired line with Picks", () => {
  it("stays reachable as CLOSED once it has Picks, and the stored market is left as the provider set it", async () => {
    const { marketId } = await seedGame({ template: "TOTAL", lineValue: 47.5 });
    const user = await seedUser("retired");
    await seedPick(user, marketId, "NO");
    await admin.from("markets").update({ status: "INACTIVE" }).eq("id", marketId);

    const detail = await getMarketDetail(marketId);
    expect(detail).not.toBeNull();
    expect(detail!.status).toBe("CLOSED"); // read-only, never open for a new Pick
    expect(detail!.totalPickCount).toBe(1);
    expect((await admin.from("markets").select("status").eq("id", marketId).single()).data!.status).toBe("INACTIVE");

    const href = resolveNotificationHref({ type: "prediction_graded", market_id: marketId, post_id: null, transaction_id: null } as never);
    expect(href).toBe(`/markets/${marketId}`);
  });

  it("a retired line nobody picked is still not found", async () => {
    const { marketId } = await seedGame({ template: "TOTAL", lineValue: 48.5 });
    await admin.from("markets").update({ status: "INACTIVE" }).eq("id", marketId);
    expect(await getMarketDetail(marketId)).toBeNull();
  });

  it("an active market is unaffected", async () => {
    const { marketId } = await seedGame({ template: "TOTAL", lineValue: 44.5 });
    expect((await getMarketDetail(marketId))?.status).toBe("ACTIVE");
  });
});
