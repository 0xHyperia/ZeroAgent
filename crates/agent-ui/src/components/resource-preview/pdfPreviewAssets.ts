/** All PDF resources come from the versioned assets shipped by this build. */
export function pdfPreviewAssetsURL(version: string) {
  return new URL(
    `${import.meta.env.BASE_URL}resource-preview/pdf/${version}/`,
    window.location.href,
  ).href;
}
