import { publishPoolAction } from "@/lib/actions/pools";
import { Button } from "@/components/ui/button";

export function PublishButton({ poolId }: { poolId: string }) {
  return (
    <form action={publishPoolAction.bind(null, poolId)}>
      <Button type="submit">Publish pool</Button>
    </form>
  );
}
