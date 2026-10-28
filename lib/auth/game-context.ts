import "server-only";
import { getPublishedPostById } from "@/lib/posts/repository";
import { getFixtureForPostPresentation } from "@/lib/sports-data/fixture-lookup";
import { formatMatchup } from "@/lib/sports-data/team-display-order";
import { postIdFromNext } from "./pick-intent";

/** The Game a sign-up / log-in is for, named in the sport's own matchup order ("Carolina Panthers @ Green Bay Packers") — or null when `next` is not a published Game's Post. Public facts only (the same ones the front door shows). Never throws. */
export async function getAuthGameMatchup(next: unknown): Promise<string | null> {
  const postId = postIdFromNext(next);
  if (!postId) return null;
  try {
    const post = await getPublishedPostById(postId);
    if (!post) return null;
    const fixture = await getFixtureForPostPresentation(post.fixtureId);
    if (!fixture) return null;
    return formatMatchup(fixture.sport, fixture.homeTeamName, fixture.awayTeamName);
  } catch {
    return null;
  }
}
