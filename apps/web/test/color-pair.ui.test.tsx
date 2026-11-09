import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColorPair } from "../src/client/components/ColorPair";

afterEach(cleanup);

const colorInput = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const hexField = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("ColorPair", () => {
  it("color input and hex field stay in sync", () => {
    const onChange = vi.fn();
    render(<ColorPair value={{ primary: "#2563eb", secondary: "#1e293b" }} onChange={onChange} />);
    fireEvent.change(colorInput("สีหลัก"), { target: { value: "#ff0000" } });
    expect(hexField("รหัสสีหลัก").value).toBe("#ff0000");
    expect(onChange).toHaveBeenLastCalledWith({ primary: "#ff0000", secondary: "#1e293b" });
    fireEvent.change(hexField("รหัสสีรอง"), { target: { value: "#00ff00" } });
    expect(colorInput("สีรอง").value).toBe("#00ff00");
    expect(onChange).toHaveBeenLastCalledWith({ primary: "#2563eb", secondary: "#00ff00" });
  });

  it("invalid hex text keeps the last valid value and shows an error", () => {
    const onChange = vi.fn();
    render(<ColorPair value={{ primary: "#2563eb", secondary: "#1e293b" }} onChange={onChange} />);
    fireEvent.change(hexField("รหัสสีหลัก"), { target: { value: "#12" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("ใช้รูปแบบ #rrggbb (Use a #rrggbb hex color)");
    expect(colorInput("สีหลัก").value).toBe("#2563eb");
    fireEvent.change(hexField("รหัสสีหลัก"), { target: { value: "#0f766e" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith({ primary: "#0f766e", secondary: "#1e293b" });
  });

  it("blur reverts invalid hex text to the last valid value", () => {
    const onChange = vi.fn();
    render(<ColorPair value={{ primary: "#2563eb", secondary: "#1e293b" }} onChange={onChange} />);
    fireEvent.change(hexField("รหัสสีหลัก"), { target: { value: "#12" } });
    fireEvent.change(hexField("รหัสสีรอง"), { target: { value: "zz" } });
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    fireEvent.blur(hexField("รหัสสีหลัก"));
    fireEvent.blur(hexField("รหัสสีรอง"));
    expect(hexField("รหัสสีหลัก").value).toBe("#2563eb");
    expect(hexField("รหัสสีรอง").value).toBe("#1e293b");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("use template colors sends null", () => {
    const onChange = vi.fn();
    render(<ColorPair value={{ primary: "#0f766e", secondary: "#1e293b" }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "ใช้สีของเทมเพลต" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("use template colors clears invalid hex text and its error", () => {
    const onChange = vi.fn();
    render(<ColorPair value={null} onChange={onChange} />);
    fireEvent.change(hexField("รหัสสีหลัก"), { target: { value: "#12" } });
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ใช้สีของเทมเพลต" }));
    expect(hexField("รหัสสีหลัก").value).toBe("#2563eb");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("shows template defaults when null and disables everything when disabled", () => {
    const onChange = vi.fn();
    const { container } = render(<ColorPair value={null} onChange={onChange} disabled />);
    expect(colorInput("สีหลัก").value).toBe("#2563eb");
    expect(colorInput("สีรอง").value).toBe("#1e293b");
    expect(hexField("รหัสสีหลัก").value).toBe("#2563eb");
    expect(hexField("รหัสสีรอง").value).toBe("#1e293b");
    const controls = container.querySelectorAll("input, button");
    expect(controls.length).toBe(5);
    for (const el of controls) {
      expect((el as HTMLInputElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getByRole("button", { name: "ใช้สีของเทมเพลต" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
