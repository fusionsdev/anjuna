import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadMore } from "../src/client/components/LoadMore";

afterEach(cleanup);

const NARROW = "กรุณากรองให้แคบลง (Narrow the filters)";

describe("LoadMore", () => {
  it("renders a Load more button when more rows exist below the max", () => {
    const onMore = vi.fn();
    render(<LoadMore shown={50} hasMore atMax={false} loading={false} onMore={onMore} narrowHint={NARROW} />);
    const button = screen.getByRole("button", { name: "โหลดเพิ่ม (Load more)" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onMore).toHaveBeenCalledTimes(1);
  });

  it("shows the max note with the narrow hint at the max", () => {
    render(<LoadMore shown={200} hasMore atMax loading={false} onMore={() => undefined} narrowHint={NARROW} />);
    expect(screen.getByText(`แสดง 200 รายการ ซึ่งเป็นจำนวนสูงสุด ${NARROW}`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "โหลดเพิ่ม (Load more)" })).toBeNull();
  });

  it("renders nothing when there are no more rows", () => {
    const view = render(<LoadMore shown={6} hasMore={false} atMax={false} loading={false} onMore={() => undefined} narrowHint={NARROW} />);
    expect(view.container.firstChild).toBeNull();
  });

  it("disables the button while loading", () => {
    const onMore = vi.fn();
    render(<LoadMore shown={50} hasMore atMax={false} loading onMore={onMore} narrowHint={NARROW} />);
    const button = screen.getByRole("button", { name: "กำลังโหลด…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onMore).not.toHaveBeenCalled();
  });
});
