"use client";

import { useActionState } from "react";
import {
  approveWalletRequestAction,
  rejectWalletRequestAction,
  type WalletRequestReviewState,
} from "@/lib/actions/wallet-requests";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const initialState: WalletRequestReviewState = { error: null };

export function ReviewForm({ requestId }: { requestId: string }) {
  const [approveState, approveFormAction, approvePending] = useActionState(
    approveWalletRequestAction,
    initialState,
  );
  const [rejectState, rejectFormAction, rejectPending] = useActionState(
    rejectWalletRequestAction,
    initialState,
  );

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <form action={approveFormAction} className="flex items-center gap-2">
        <input type="hidden" name="requestId" value={requestId} />
        <Input name="adminNote" placeholder="Note (optional)" className="h-8 w-32 text-xs" />
        <Button type="submit" size="sm" disabled={approvePending}>
          {approvePending ? "Approving…" : "Approve"}
        </Button>
      </form>
      <form action={rejectFormAction}>
        <input type="hidden" name="requestId" value={requestId} />
        <Button type="submit" variant="outline" size="sm" disabled={rejectPending}>
          {rejectPending ? "Rejecting…" : "Reject"}
        </Button>
      </form>
      {(approveState.error || rejectState.error) && (
        <span className="w-full text-right text-xs text-danger">
          {approveState.error || rejectState.error}
        </span>
      )}
    </div>
  );
}
