(() => {
  const page = document.querySelector(".owner-campaign-page");
  if (!page) return;

  const renumber = (repeatable) => {
    const prefix = repeatable.dataset.repeatable;
    const rows = repeatable.querySelectorAll(":scope > [data-repeatable-rows] > .owner-campaign-row");
    rows.forEach((row, index) => {
      row.querySelectorAll("[name], [id], label[for]").forEach((element) => {
        for (const attribute of ["name", "id", "for"]) {
          const value = element.getAttribute(attribute);
          if (!value || !prefix) continue;
          element.setAttribute(
            attribute,
            value.replace(new RegExp(`${prefix}-(?:__INDEX__|\\d+)-`), `${prefix}-${index}-`),
          );
        }
      });
    });
    const add = repeatable.querySelector(":scope > [data-add-row]");
    if (add instanceof HTMLButtonElement) {
      add.disabled = rows.length >= Number(repeatable.dataset.maximum ?? "0");
    }
  };

  page.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const add = target.closest("[data-add-row]");
    if (add) {
      const repeatable = add.closest("[data-repeatable]");
      const rows = repeatable?.querySelector(":scope > [data-repeatable-rows]");
      const template = repeatable?.querySelector(":scope > template");
      if (!(repeatable instanceof HTMLElement) || !(rows instanceof HTMLElement) || !(template instanceof HTMLTemplateElement)) return;
      const count = rows.querySelectorAll(":scope > .owner-campaign-row").length;
      if (count >= Number(repeatable.dataset.maximum ?? "0")) return;
      rows.append(template.content.cloneNode(true));
      renumber(repeatable);
      rows.querySelector(".owner-campaign-row:last-child input, .owner-campaign-row:last-child textarea, .owner-campaign-row:last-child select")?.focus();
      return;
    }

    const remove = target.closest("[data-remove-row]");
    if (remove) {
      const repeatable = remove.closest("[data-repeatable]");
      remove.closest(".owner-campaign-row")?.remove();
      if (repeatable instanceof HTMLElement) renumber(repeatable);
    }
  });

  const synchronizeOptionalSection = (toggle) => {
    const section = page.querySelector(`[data-optional-section="${CSS.escape(toggle.name)}"]`);
    if (!(section instanceof HTMLElement)) return;
    section.hidden = !toggle.checked;
    section.querySelectorAll("input, textarea, select, button").forEach((control) => {
      if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement || control instanceof HTMLButtonElement) {
        control.disabled = !toggle.checked;
      }
    });
  };

  page.querySelectorAll(".owner-campaign-toggle input[type='checkbox']").forEach((toggle) => {
    if (!(toggle instanceof HTMLInputElement)) return;
    synchronizeOptionalSection(toggle);
    toggle.addEventListener("change", () => synchronizeOptionalSection(toggle));
  });
  page.querySelectorAll("[data-repeatable]").forEach((repeatable) => {
    if (repeatable instanceof HTMLElement) renumber(repeatable);
  });
})();
