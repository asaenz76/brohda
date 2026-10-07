// "Back means where I came from." — knowing whether there IS an in-app place to go back to.
//
// The browser does not say whether the previous history entry is a page of this app (history.length also counts the site the visitor came from, a
// bookmark's previous page, or a notification link's), so going back blindly could leave Brohda. This keeps a tiny stack of the pathnames visited in
// THIS document's lifetime, in history order. A Back control uses real history (router.back(), which also restores the scroll position) only when
// the stack says the previous entry is ours; otherwise it goes to its canonical fallback — by REPLACING the current entry, so a deep-linked Market
// does not stay behind the Post it fell back to (Market → Back → Post → Back → Market would be a loop). A reload empties the stack on purpose: after a reload the
// previous entry is unknown, so Back takes the fallback — safe, never an exit.
//
// Pure functions over an explicit state so the rules are unit-tested; the module-level state and the browser listeners live in the tracker component.
export interface InAppHistory {
  /** Pathnames in the order they sit in the browser history, the last being the current page. */
  stack: string[];
}

export const emptyHistory = (): InAppHistory => ({ stack: [] });

/** How the current page was reached: a link (push), the browser's Back/Forward buttons (history), or a replace (a Back control using its fallback). */
export type NavigationKind = "push" | "history" | "replace";

/** Record that the current page is `path`. */
export function recordLocation(state: InAppHistory, path: string, kind: NavigationKind): InAppHistory {
  const { stack } = state;
  if (stack.length === 0) return { stack: [path] };
  if (stack[stack.length - 1] === path) return state; // a query-only change (a tab) or a refresh of the same page
  if (kind === "replace") return { stack: [...stack.slice(0, -1), path] }; // the current entry was replaced, not added to
  if (kind === "history" && stack[stack.length - 2] === path) return { stack: stack.slice(0, -1) }; // Back
  return { stack: [...stack, path] }; // a link, or Forward
}

/** True when the previous history entry is a page of this app. */
export const canGoBackInApp = (state: InAppHistory): boolean => state.stack.length > 1;
