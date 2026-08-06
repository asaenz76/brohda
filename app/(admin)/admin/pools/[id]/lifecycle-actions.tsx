"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  advanceLockedPoolAction,
  archivePoolAction,
  cancelPoolAction,
  checkPoolResultNowAction,
  deletePoolAction,
  forceLockPoolAction,
  gradeManuallyAction,
  unarchivePoolAction,
  type CancelPoolState,
  type CheckResultState,
  type GradeManuallyState,
} from "@/lib/actions/pool-lifecycle";
import { undoPoolGradingAction } from "@/lib/actions/settlements";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Reverts an unconfirmed READY_FOR_REVIEW pool back to LOCKED so it can be
// re-graded — e.g. the wrong grading path was used the first time. Only
// ever offered while nothing's been confirmed yet (page.tsx's own guard),
// so there's no money to move and no confirmation step needed, same
// no-frills shape as ForceLockButton/AdvanceLockedPoolButton.
export function UndoGradingButton({ poolId }: { poolId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleUndo() {
    setError(null);
    startTransition(async () => {
      const result = await undoPoolGradingAction(poolId);
      if (!result.success) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-1.5">
      <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={handleUndo}>
        {isPending ? "Undoing…" : "Back to grading"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function ForceLockButton({ poolId }: { poolId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleLock() {
    setError(null);
    startTransition(async () => {
      const result = await forceLockPoolAction(poolId);
      if (!result.success) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-1.5">
      <Button type="button" variant="outline" disabled={isPending} onClick={handleLock}>
        {isPending ? "Locking…" : "Lock now"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function AdvanceLockedPoolButton({ poolId }: { poolId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleAdvance() {
    setError(null);
    startTransition(async () => {
      const result = await advanceLockedPoolAction(poolId);
      if (!result.success) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-1.5">
      <Button type="button" variant="outline" disabled={isPending} onClick={handleAdvance}>
        {isPending ? "Advancing…" : "Advance to awaiting result"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

const initialCheckResultState: CheckResultState = { message: null, error: null };

export function CheckResultButton({ poolId }: { poolId: string }) {
  const [state, formAction, pending] = useActionState(checkPoolResultNowAction, initialCheckResultState);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="poolId" value={poolId} />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Checking…" : "Check for result now"}
      </Button>
      {state.message && <p className="text-sm text-text-secondary">{state.message}</p>}
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}

const initialGradeManuallyState: GradeManuallyState = { error: null };

export function GradeManuallyButton({ poolId }: { poolId: string }) {
  const [state, formAction, pending] = useActionState(gradeManuallyAction, initialGradeManuallyState);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="poolId" value={poolId} />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Preparing…" : "Grade manually"}
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}

// Only ever offered while the pool has zero entries (page.tsx's own guard),
// so there's no reason string to feed a refund/notification the way
// CancelPoolButton's does — same no-reason-required shape as
// deleteFixtureAction. Mirrors FixtureManagementRow's two-step confirm UX
// exactly, since deletePoolAction is a direct-call action, not a FormData one.
export function DeletePoolButton({ poolId }: { poolId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      const result = await deletePoolAction(poolId);
      if (!result.success) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      router.push("/admin/pools");
    });
  }

  if (confirming) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="destructive" size="sm" disabled={isPending} onClick={handleDelete}>
          {isPending ? "Deleting…" : "Confirm delete"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <Button type="button" variant="destructive" onClick={() => setConfirming(true)}>
      Delete pool
    </Button>
  );
}

// Fully reversible (unlike DeletePoolButton), so a single click toggles
// straight through — no confirm step, matching ForceLockButton's plain shape.
export function ArchivePoolButton({ poolId, archived }: { poolId: string; archived: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleToggle() {
    setError(null);
    startTransition(async () => {
      const result = archived ? await unarchivePoolAction(poolId) : await archivePoolAction(poolId);
      if (!result.success) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-1.5">
      <Button type="button" variant="outline" disabled={isPending} onClick={handleToggle}>
        {isPending ? (archived ? "Unarchiving…" : "Archiving…") : archived ? "Unarchive pool" : "Archive pool"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

const initialCancelPoolState: CancelPoolState = { error: null };

// Same inline-expand pattern as VoidEntryForm/ToggleActiveForm — a plain
// button until clicked, then a required-reason input + Confirm.
export function CancelPoolButton({ poolId }: { poolId: string }) {
  const [state, formAction, pending] = useActionState(cancelPoolAction, initialCancelPoolState);
  const [open, setOpen] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  if (!open) {
    return (
      <Button type="button" variant="destructive" onClick={() => setOpen(true)}>
        Cancel pool
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="poolId" value={poolId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <Input name="reason" placeholder="Reason (required)" required className="h-8 w-48 text-xs" />
      <Button type="submit" variant="destructive" size="sm" disabled={pending}>
        {pending ? "Cancelling…" : "Confirm cancel"}
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
