import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
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
    fireEvent.keyDown(document, { key: "Escape" });
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
});
