/** Native fragment navigation inside the existing scriptless document. No iframe bridge. */
export function createDocxPageNavigation(root: HTMLElement, outline: HTMLDetailsElement | null) {
  const pages = [...root.querySelectorAll<HTMLElement>("section.docx")];
  if (!pages.length) return outline;
  const doc = root.ownerDocument;
  const navigation = outline ?? doc.createElement("details");
  navigation.className = "za-docx-outline";
  navigation.open = false;
  let summary = navigation.querySelector("summary");
  if (!summary) {
    summary = doc.createElement("summary");
    navigation.prepend(summary);
  }
  summary.textContent = `页面与目录 · ${pages.length}`;
  const list = doc.createElement("nav");
  list.className = "za-docx-page-list";
  list.setAttribute("aria-label", "文档页面");
  const occupied = new Set([...root.querySelectorAll("[id]")].map((element) => element.id));
  let budget = 6000;
  for (const [index, page] of pages.slice(0, 80).entries()) {
    let id = `za-docx-page-${index + 1}`;
    while (occupied.has(id)) id += "-page";
    occupied.add(id);
    const anchor = doc.createElement("span");
    anchor.id = id;
    anchor.className = "za-docx-outline-anchor";
    page.before(anchor);
    const link = doc.createElement("a");
    link.setAttribute("href", `about:srcdoc#${id}`);
    link.setAttribute("aria-label", `第 ${index + 1} 页`);
    const number = doc.createElement("span");
    number.textContent = String(index + 1);
    link.append(number);
    // Cover duplication has a separate node budget; large documents retain numbered links.
    const count = page.querySelectorAll("*").length;
    if (count <= budget) {
      budget -= count;
      const thumb = doc.createElement("div");
      thumb.className = "za-docx-page-thumb";
      thumb.setAttribute("aria-hidden", "true");
      thumb.setAttribute("inert", "");
      const wrapper = doc.createElement("div");
      wrapper.className = "docx-wrapper za-docx-page-mini";
      const clone = page.cloneNode(true) as HTMLElement;
      clone.removeAttribute("id");
      for (const element of clone.querySelectorAll("[id],[name],[href]")) {
        element.removeAttribute("id");
        element.removeAttribute("name");
        element.removeAttribute("href");
      }
      wrapper.append(clone);
      thumb.append(wrapper);
      link.append(thumb);
    }
    list.append(link);
  }
  if (pages.length > 80) {
    const note = doc.createElement("p");
    note.textContent = "前 80 页导航，完整文档仍可滚动阅读。";
    list.append(note);
  }
  summary.after(list);
  return navigation;
}
