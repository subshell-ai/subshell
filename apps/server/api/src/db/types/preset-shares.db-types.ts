export interface PresetShareTable {
  id: string;
  presetId: string;
  granteeUserId: string | null;
  permission: "view" | "edit";
  createdBy: string;
  createdAt: string;
}
