import { permanentRedirect } from "next/navigation";

// "How it works" was the first, shorter explainer. /rules is now the single canonical
// place for how Brohda works, so the old address keeps working and lands there.
export default function HowItWorksRedirect() {
  permanentRedirect("/rules");
}
