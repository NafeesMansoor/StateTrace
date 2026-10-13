# Feature Implementation: Mandatory Digital Signature and Export Integrity Protection

## Objective

Implement a mandatory digital signature and copyright attribution system across the entire application. Every design exported in PNG or SVG format must automatically include the signature:

**Copyright Nafees Mansoor**

The feature must be integrated into the core export pipeline, not implemented as an optional UI element.

## 1. Digital Signature Design

Create a professional, subtle, and visually consistent signature for all exported designs.

- Signature text: `Copyright Nafees Mansoor`
- Typography: elegant, clean, and modern, resembling a professional designer's signature.
- Appearance: unobtrusive but legible, with appropriate contrast against the background.
- Default placement: bottom-right corner, with adequate padding from the canvas edges.
- Scaling: automatically adjust font size, spacing, and padding according to canvas dimensions.
- Ensure the signature does not obscure important design elements unnecessarily.
- Make the styling consistent across PNG and SVG exports.
- Use a vector-based signature wherever possible for crisp rendering at any resolution.
- Prevent clipping, distortion, or unintended wrapping.

## 2. Mandatory PNG Export Integration

Modify the central PNG export pipeline so that:

1. The signature is rendered onto the final exported canvas automatically.
2. The signature is included in the final rasterized image, rather than being a separate downloadable layer.
3. All PNG export methods, including download buttons, keyboard shortcuts, context menus, and alternate export paths, pass through the same protected export function.
4. The signature remains visible at different canvas sizes and export resolutions.
5. The export operation fails safely if the signature cannot be rendered.

## 3. Mandatory SVG Export Integration

Modify the central SVG export pipeline so that:

1. Every exported SVG includes the copyright signature as part of its SVG content.
2. The signature is represented using valid SVG elements, such as a `<text>` element or vector paths.
3. The signature is positioned correctly relative to the exported viewBox.
4. The signature scales proportionally with the design.
5. The SVG remains valid, portable, and compatible with common SVG viewers and vector-editing software.
6. Every SVG export route uses the same protected export function.
7. Export must fail if the mandatory signature element is missing or cannot be inserted.

## 4. Centralized Export Architecture

Create a single, reusable export-protection module responsible for:

- Generating the copyright signature.
- Applying the signature to PNG exports.
- Applying the signature to SVG exports.
- Validating the final exported artifact.
- Performing export-integrity checks.

Do not duplicate signature logic across individual components.

Audit the complete codebase to identify every export route. Refactor all export operations to use the centralized protected export pipeline.

No component should be able to export a PNG or SVG directly without passing through this module.

## 5. Tamper Detection and Integrity Protection

Implement an integrity-protection mechanism to detect unauthorized removal or disabling of the signature system.

Requirements:

- Maintain an explicit list of protected export functions and mandatory signature-generation components.
- Add automated tests verifying that both PNG and SVG exports contain the required attribution.
- Add runtime validation before completing each export.
- Ensure that if the signature module is unavailable, disabled, or fails validation, the export operation is blocked.
- Add build-time checks that detect accidental removal of signature-generation logic or its integration into the export pipeline.
- Add CI checks that fail when protected export functions are modified without updating the corresponding integrity tests.
- Do not rely solely on a visible signature element or a simple Boolean flag as proof of integrity.

For stronger protection, consider signing release builds and verifying their integrity against a trusted manifest. Keep signing credentials outside the client-side source code.

**Important limitation:** Client-side JavaScript cannot provide absolute tamper-proof protection when the complete source code is publicly available. Runtime checks, build checks, and tests improve resistance to accidental or unauthorized modification, but a determined developer can alter the checks themselves. For stronger enforcement, use a trusted server-side export service or a separately controlled signing component.

## 6. Regression Testing

Create automated tests covering the following cases:

- Normal PNG export includes the copyright signature.
- Normal SVG export includes the copyright signature.
- Signature placement and scaling are correct for small and large canvases.
- Transparent PNG exports preserve transparency outside the signature.
- SVG output remains valid and opens in standard vector editors.
- Missing signature-generation logic causes the export tests to fail.
- Bypassing the protected export pipeline is detected by static analysis or CI checks.
- Signature rendering failures prevent the export from completing.
- Existing drawing, editing, preview, and export functionality continues to work.

## 7. Implementation Constraints

- First inspect the existing codebase and identify its framework, rendering engine, export utilities, and all export entry points.
- Preserve the existing application architecture and visual design.
- Avoid unnecessary dependencies.
- Do not introduce a watermark into the live editing canvas unless explicitly required. The mandatory signature is for exported artifacts.
- Avoid changing the user's original design data merely to insert the signature.
- Ensure the signature is included in both PNG and SVG outputs, regardless of which UI control initiates the export.
- Do not claim that the application is tamper-proof. Document the actual integrity guarantees provided.

## 8. Completion Criteria

Before finishing:

1. Provide a summary of the files changed.
2. Identify every protected export route.
3. Demonstrate that PNG and SVG exports include `Copyright Nafees Mansoor`.
4. Report the automated tests executed and their results.
5. Explain what modifications the integrity checks detect and what they cannot prevent.
6. Confirm that no export route bypasses the centralized protection mechanism.

Implement the feature in the existing codebase, test it, and report any limitations rather than merely proposing changes.