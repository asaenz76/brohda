"use client";

import { useActionState } from "react";
import { createCategoryMappingAction, type ActionResult } from "@/lib/actions/discovery-categories";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import type { DiscoveryCategory } from "@/lib/prediction-markets/discovery/types";

const initialState: ActionResult = { success: false, error: null };

export function CreateMappingForm({ categories }: { categories: DiscoveryCategory[] }) {
  const [state, formAction, pending] = useActionState(createCategoryMappingAction, initialState);

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <p className="text-sm font-semibold text-text-primary">Map a provider tag to a category</p>
        <form action={formAction} className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1.5 sm:col-span-1">
            <Label htmlFor="categoryId">Category</Label>
            <select id="categoryId" name="categoryId" required className="h-9 w-full rounded-md border border-border-subtle bg-surface-primary px-2 text-sm">
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="provider">Provider</Label>
            <Input id="provider" name="provider" placeholder="api-sports" defaultValue="api-sports" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="providerTag">Provider tag</Label>
            <Input id="providerTag" name="providerTag" placeholder="NFL" required />
          </div>
          <div className="flex items-end gap-2">
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <input type="checkbox" name="enabled" defaultChecked className="h-4 w-4" />
              Enabled
            </label>
          </div>
          <div className="sm:col-span-4">
            <Button type="submit" disabled={pending || categories.length === 0}>
              {pending ? "Adding…" : "Add mapping"}
            </Button>
            {categories.length === 0 && <p className="mt-1 text-xs text-text-muted">Add a category first.</p>}
          </div>
          {state.error && (
            <p role="alert" className="text-sm text-danger sm:col-span-4">
              {state.error}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
