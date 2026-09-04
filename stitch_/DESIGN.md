---
name: Vibrant Paws
colors:
  surface: '#f4fafd'
  surface-dim: '#d4dbdd'
  surface-bright: '#f4fafd'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#eef5f7'
  surface-container: '#e8eff1'
  surface-container-high: '#e2e9ec'
  surface-container-highest: '#dde4e6'
  on-surface: '#161d1f'
  on-surface-variant: '#3c494e'
  inverse-surface: '#2b3234'
  inverse-on-surface: '#ebf2f4'
  outline: '#6c797f'
  outline-variant: '#bbc9cf'
  surface-tint: '#00677f'
  primary: '#00677f'
  on-primary: '#ffffff'
  primary-container: '#00d2ff'
  on-primary-container: '#00566a'
  inverse-primary: '#47d6ff'
  secondary: '#87503f'
  on-secondary: '#ffffff'
  secondary-container: '#fdb5a0'
  on-secondary-container: '#794534'
  tertiary: '#ba1245'
  on-tertiary: '#ffffff'
  tertiary-container: '#ffaab4'
  on-tertiary-container: '#a00038'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#b6ebff'
  primary-fixed-dim: '#47d6ff'
  on-primary-fixed: '#001f28'
  on-primary-fixed-variant: '#004e60'
  secondary-fixed: '#ffdbd0'
  secondary-fixed-dim: '#fdb5a0'
  on-secondary-fixed: '#350f04'
  on-secondary-fixed-variant: '#6b3929'
  tertiary-fixed: '#ffd9dc'
  tertiary-fixed-dim: '#ffb2ba'
  on-tertiary-fixed: '#400011'
  on-tertiary-fixed-variant: '#910031'
  background: '#f4fafd'
  on-background: '#161d1f'
  surface-variant: '#dde4e6'
typography:
  headline-xl:
    fontFamily: Quicksand
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Quicksand
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
  headline-lg-mobile:
    fontFamily: Quicksand
    fontSize: 20px
    fontWeight: '700'
    lineHeight: 28px
  body-lg:
    fontFamily: Quicksand
    fontSize: 18px
    fontWeight: '500'
    lineHeight: 26px
  body-md:
    fontFamily: Quicksand
    fontSize: 16px
    fontWeight: '500'
    lineHeight: 24px
  body-sm:
    fontFamily: Quicksand
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: Quicksand
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.05em
  label-sm:
    fontFamily: Quicksand
    fontSize: 10px
    fontWeight: '700'
    lineHeight: 14px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 4px
  container-padding: 20px
  gutter-md: 16px
  stack-sm: 8px
  stack-md: 12px
  stack-lg: 24px
---

## Brand & Style

This design system embodies a "Web3-inspired cute" aesthetic—a high-fidelity, energetic, and premium approach to pet care. The brand personality is optimistic, caring, and technologically advanced, bridging the gap between digital-native trends and soulful, emotional connections.

The visual style is a sophisticated blend of **Glassmorphism** and **Tactile Modernism**. It leverages soft 3D depths, vibrant environmental gradients, and translucent surfaces to create a sense of lightness and wonder. The target audience is modern pet owners who value high-quality digital experiences that feel as warm and premium as the care they provide for their companions. 

Key pillars:
- **Energetic Warmth:** Utilizing vibrant sky blues and soft peach tones to create an inviting atmosphere.
- **Dimensionality:** Heavy use of 3D assets, soft shadows, and layered transparency.
- **Clarity:** Despite the rich visual effects, core content is housed in clean, high-contrast cards to ensure effortless navigation.

## Colors

The palette is anchored by a dynamic interplay between **Vibrant Sky Blue** (#00D2FF) and **Soft Peach** (#FFB7A1). These colors are frequently used as subtle background gradients to evoke a "daylight" feel. 

The **Core Accent** (#FF4D73) is used sparingly but impactfully for critical calls-to-action, status indicators, and high-energy highlights. 

- **Primary:** Represents the sky, freshness, and innovation.
- **Secondary:** Represents warmth, fur, and approachability.
- **Tertiary (Accent):** The "pop" color for engagement.
- **Neutrals:** A soft charcoal for text to maintain readability without the harshness of pure black, and pure white for elevated content cards.
- **Iconography:** High-saturation multi-colors are encouraged for category icons to aid rapid visual recognition.

## Typography

The typography system uses **Quicksand** across all roles to maintain a friendly, rounded, and accessible character. 

The hierarchy is built on generous font weights (Bold and Medium) to compete with the rich 3D imagery. Headlines should feel "chunky" and welcoming. For mobile displays, large headlines are scaled down slightly to ensure text doesn't wrap awkwardly around the high-detail illustrations.

Use tighter letter spacing on larger headlines to give them a premium, "logo-like" feel. Labels and small captions should maintain higher tracking for legibility against colored backgrounds.

## Layout & Spacing

This design system uses a **Fluid Grid** with generous internal safe areas. Content is primarily organized into "Floating Cards" that sit on top of the ambient background gradient.

- **Margins:** 20px side margins on mobile to ensure the glassmorphic edges of the search bar and cards have room to breathe.
- **Rhythm:** A 4px baseline grid ensures consistent vertical rhythm. Elements are typically separated by 12px (small groups) or 24px (major sections).
- **Responsiveness:** On tablet and desktop, cards transition from a single-column stack to a multi-column masonry-style grid to showcase the 3D assets more effectively.

## Elevation & Depth

Hierarchy is established through a mix of **Glassmorphism** and **Soft Ambient Shadows**.

1.  **Level 0 (Base):** The environmental gradient (Sky Blue to Peach).
2.  **Level 1 (Navigation/Search):** Glassmorphic surfaces. Use a backdrop blur of 20px and a 10% white tint with a subtle 1px white inner border to simulate light hitting the edge of glass.
3.  **Level 2 (Content Cards):** Pure white surfaces with very soft, large-radius shadows (Blur: 30px, Y: 10px, Opacity: 5% Black). These should feel like they are floating just above the background.
4.  **Level 3 (Interactive Elements/Icons):** Highly saturated elements with "glow" shadows that match the element's color (e.g., a blue icon casts a soft blue shadow) to increase vibrancy.

## Shapes

The shape language is "Squircle-adjacent"—highly rounded and organic to match the friendly pet-focused theme.

- **Standard Cards:** Use `rounded-lg` (16px) for main content areas.
- **Interactive Buttons/Search:** Use `rounded-xl` (24px) or full pill-shape to invite touch.
- **Illustrations:** 3D assets should have soft, rounded silhouettes. Avoid any sharp 90-degree angles in the UI.

## Components

- **Search Bar:** A prominent glassmorphic field at the top. It features a thin 1px white border, internal blur, and a colorful "AI" or "Bot" avatar as a trailing element.
- **Action Chips:** Small, pill-shaped tags used for categories (e.g., "Vaccine Records"). These should use light tints of the primary/secondary colors with bold text.
- **Grid Icons:** Highly saturated, colorful 3D or high-fidelity 2D icons. Each icon sits on a very soft, circular colored "halo" or background.
- **Primary Buttons:** High-energy gradient fills using the Primary and Tertiary colors. They should have a "squishy" feel with a slight scale-down animation on press.
- **Cards:** Clean white backgrounds with internal padding of 16px. Images within cards should often "break the frame" (3D objects overlapping the card edge) to enhance the sense of depth.
- **Progress Indicators:** Use the #FF4D73 accent color for tracking "Growth Records" or health status to ensure they stand out against the softer palette.