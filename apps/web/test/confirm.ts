import { fireEvent, screen, within } from "@testing-library/react";

/** Answers the open ConfirmDialog. Returns the dialog element. */
export async function answerConfirm(accept: boolean): Promise<HTMLElement> {
  const dialog = await screen.findByRole("alertdialog");
  const buttons = within(dialog).getAllByRole("button");
  const cancel = buttons.find((b) => b.textContent === "ยกเลิก (Cancel)")!;
  const confirm = buttons.find((b) => b !== cancel)!;
  fireEvent.click(accept ? confirm : cancel);
  return dialog;
}
