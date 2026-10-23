import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConfirm } from "../src/client/components/ConfirmDialog";
import { answerConfirm } from "./confirm";

afterEach(cleanup);

function Harness() {
  const [confirm, dialog] = useConfirm();
  const [log, setLog] = useState<string[]>([]);
  const ask = (name: string) => async () => {
    const ok = await confirm({ title: `ลบ ${name}?`, body: "ย้อนกลับไม่ได้", confirmLabel: "ลบ (Delete)", tone: "danger" });
    setLog((l) => [...l, `${name}:${ok}`]);
  };
  return (
    <>
      <button onClick={ask("a")}>ask a</button>
      <button onClick={ask("b")}>ask b</button>
      <p>{log.join(",")}</p>
      {dialog}
    </>
  );
}

describe("useConfirm", () => {
  it("resolves true on confirm and false on cancel", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("ask a"));
    const dialog = await answerConfirm(true);
    expect(dialog.textContent).toContain("ลบ a?");
    expect(await screen.findByText("a:true")).toBeTruthy();
    fireEvent.click(screen.getByText("ask a"));
    await answerConfirm(false);
    expect(await screen.findByText("a:true,a:false")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("cancels on Escape and on the scrim, and focuses Cancel first", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("ask a"));
    await screen.findByRole("alertdialog");
    expect(document.activeElement?.textContent).toBe("ยกเลิก (Cancel)");
    // Focus is inside the dialog, so Escape is handled by the dialog itself.
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(await screen.findByText("a:false")).toBeTruthy();
    fireEvent.click(screen.getByText("ask a"));
    fireEvent.click(document.querySelector(".modal-wrap")!);
    expect(await screen.findByText("a:false,a:false")).toBeTruthy();
  });

  it("resolves an open dialog as false when a second confirm starts", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("ask a"));
    await screen.findByRole("alertdialog");
    await act(async () => { fireEvent.click(screen.getByText("ask b")); });
    expect(await screen.findByText("a:false")).toBeTruthy();
    await answerConfirm(true);
    expect(await screen.findByText("a:false,b:true")).toBeTruthy();
  });

  it("handles Escape inside the dialog and hides it from a document Escape listener", async () => {
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    try {
      render(<Harness />);
      fireEvent.click(screen.getByText("ask a"));
      await screen.findByRole("alertdialog");
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      expect(await screen.findByText("a:false")).toBeTruthy();
      expect(outer).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", outer);
    }
  });

  it("keeps Tab inside the dialog: last to first, and Shift+Tab first to last", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("ask a"));
    const dialog = await screen.findByRole("alertdialog");
    const [cancel, accept] = within(dialog).getAllByRole("button");
    accept!.focus();
    expect(fireEvent.keyDown(accept!, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(cancel);
    expect(fireEvent.keyDown(cancel!, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(accept);
    // Inside the cycle the browser moves focus, so the key is left alone.
    expect(fireEvent.keyDown(accept!, { key: "Tab", shiftKey: true })).toBe(true);
    cancel!.focus();
    expect(fireEvent.keyDown(cancel!, { key: "Tab" })).toBe(true);
  });

  it("returns focus to the first opener after a second confirm replaces the first and closes", async () => {
    render(<Harness />);
    const opener = screen.getByText("ask a");
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("alertdialog");
    expect(document.activeElement?.textContent).toBe("ยกเลิก (Cancel)");
    // The second confirm starts while focus sits on dialog 1's Cancel button.
    await act(async () => { fireEvent.click(screen.getByText("ask b")); });
    expect(await screen.findByText("a:false")).toBeTruthy();
    await answerConfirm(false);
    expect(await screen.findByText("a:false,b:false")).toBeTruthy();
    expect(document.activeElement).toBe(opener);
  });

  it("resolves an open dialog as false when the screen unmounts", async () => {
    let asked!: Promise<boolean>;
    function Once() {
      const [confirm, dialog] = useConfirm();
      return <><button onClick={() => { asked = confirm({ title: "ลบ?", confirmLabel: "ลบ (Delete)" }); }}>ask</button>{dialog}</>;
    }
    const view = render(<Once />);
    fireEvent.click(screen.getByText("ask"));
    await screen.findByRole("alertdialog");
    view.unmount();
    await expect(asked).resolves.toBe(false);
  });

  it("keeps focus in the dialog after a click on its text: Escape, Tab and Shift+Tab work from the dialog element", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("ask a"));
    const dialog = await screen.findByRole("alertdialog");
    // A click on the title or body focuses the nearest focusable ancestor, which is the dialog itself.
    expect(dialog.getAttribute("tabindex")).toBe("-1");
    const [cancel, accept] = within(dialog).getAllByRole("button");
    dialog.focus();
    expect(fireEvent.keyDown(dialog, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(cancel);
    dialog.focus();
    expect(fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(accept);
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(await screen.findByText("a:false")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("confirmDisabled disables the confirm button, ignores a click on it, and leaves Cancel working", async () => {
    let asked!: Promise<boolean>;
    function Disabled() {
      const [confirm, dialog] = useConfirm();
      return <><button onClick={() => { asked = confirm({ title: "ลบ?", confirmLabel: "ลบ (Delete)", confirmDisabled: true }); }}>ask</button>{dialog}</>;
    }
    render(<Disabled />);
    fireEvent.click(screen.getByText("ask"));
    const dialog = await answerConfirm(true);
    const accept = within(dialog).getByText("ลบ (Delete)") as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await answerConfirm(false);
    await expect(asked).resolves.toBe(false);
  });

  it("cancel() resolves an open dialog as false and removes it, and does nothing when none is open", async () => {
    let asked!: Promise<boolean>;
    let cancel!: () => void;
    function WithCancel() {
      const [confirm, dialog, cancelOpen] = useConfirm();
      cancel = cancelOpen;
      return <><button onClick={() => { asked = confirm({ title: "ลบ?", confirmLabel: "ลบ (Delete)" }); }}>ask</button>{dialog}</>;
    }
    render(<WithCancel />);
    act(() => cancel());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByText("ask"));
    await screen.findByRole("alertdialog");
    act(() => cancel());
    await expect(asked).resolves.toBe(false);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
