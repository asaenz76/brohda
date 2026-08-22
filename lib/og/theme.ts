// Literal hex mirror of app/globals.css's light/dark tokens — satori (the
// renderer behind next/og's ImageResponse) has no notion of CSS custom
// properties or a `.dark` class, so every color a share image needs has to
// be a plain string here instead of a Tailwind class.
export interface SharePalette {
  surfacePrimary: string;
  surfaceElevated: string;
  borderSubtle: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
}

export const SHARE_PALETTES: Record<"light" | "dark", SharePalette> = {
  light: {
    surfacePrimary: "#ffffff",
    surfaceElevated: "#f7f7f7",
    borderSubtle: "#e8e8e8",
    textPrimary: "#111111",
    textSecondary: "#737373",
    textMuted: "#707070",
  },
  dark: {
    surfacePrimary: "#181a20",
    surfaceElevated: "#23262e",
    borderSubtle: "#2a2d35",
    textPrimary: "#f5f5f5",
    textSecondary: "#a1a1aa",
    textMuted: "#8d8d95",
  },
};
