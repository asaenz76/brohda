"use client";

import { useActionState } from "react";
import { createCategoryAction, type ActionResult } from "@/lib/actions/discovery-categories";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

const initialState: ActionResult = { success: false, error: null };

export function CreateCategoryForm({ nextDisplayOrder }: { nextDisplayOrder: number }) {
  const [state, formAction, pending] = useActionState(createCategoryAction, initialState);

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <p className="text-sm font-semibold text-text-primary">Add a discovery category</p>
        <form action={formAction} className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="slug">Slug</Label>
            <Input id="slug" name="slug" placeholder="world" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="displayName">Display name</Label>
            <Input id="displayName" name="displayName" placeholder="World" required />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="description">Description (optional)</Label>
            <Input id="description" name="description" placeholder="Shown only in admin, not to consumers" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="displayOrder">Display order</Label>
            <Input id="displayOrder" name="displayOrder" type="number" defaultValue={nextDisplayOrder} required />
          </div>
          <div className="flex items-end gap-2">
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <input type="checkbox" name="enabled" defaultChecked className="h-4 w-4" />
              Enabled
            </label>
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add category"}
            </Button>
          </div>
          {state.error && (
            <p role="alert" className="text-sm text-danger sm:col-span-2">
              {state.error}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
