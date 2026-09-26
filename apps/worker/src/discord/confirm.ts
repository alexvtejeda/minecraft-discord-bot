import { ButtonStyle, ComponentType, type APIActionRowComponent, type APIButtonComponent } from "discord-api-types/v10";

export const CANCEL_ID = "x";
const MAX_CUSTOM_ID = 100;

/** Confirm + Cancel. The action and its args travel in custom_id, so nothing is stored. */
export function confirmRow(action: string, args: string[], label: string): APIActionRowComponent<APIButtonComponent>[] {
  const id = ["c", action, ...args].join(":");
  if (id.length > MAX_CUSTOM_ID) throw new Error(`custom_id too long (${id.length}): ${id}`);
  return [
    {
      type: ComponentType.ActionRow,
      components: [
        { type: ComponentType.Button, style: ButtonStyle.Danger, label, custom_id: id },
        { type: ComponentType.Button, style: ButtonStyle.Secondary, label: "Cancel", custom_id: CANCEL_ID },
      ],
    },
  ];
}

/** "c:<action>:<a>:<b>" → { action, args }. An action whose last arg may hold colons rejoins it itself. */
export function parseConfirmId(id: string): { action: string; args: string[] } | null {
  const [c, action, ...args] = id.split(":");
  return c === "c" && action ? { action, args } : null;
}
