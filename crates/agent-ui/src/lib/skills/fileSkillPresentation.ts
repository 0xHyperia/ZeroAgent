const fileSkills = {
  documents: { zh: "文档", en: "Documents", extension: "docx" },
  presentations: { zh: "演示文稿", en: "Presentations", extension: "pptx" },
  pdf: { zh: "PDF", en: "PDF", extension: "pdf" },
  spreadsheet: { zh: "表格", en: "Spreadsheets", extension: "xlsx" },
} as const;

export function builtinFileSkillPresentation(name: string, builtin: boolean | undefined) {
  if (builtin && Object.hasOwn(fileSkills, name)) {
    return fileSkills[name as keyof typeof fileSkills];
  }
}
