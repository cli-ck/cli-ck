// @vitest-environment happy-dom

import type { Agent } from "@/features/ai-companion/ai/lib/agents";
import {
  AgentCard,
  AgentDetailsDialog,
} from "@/settings/sections/AgentsSection";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const builtinAgent: Agent = {
  id: "builtin:coder",
  name: "Coder",
  description: "General-purpose coding assistant.",
  instructions: "BUILTIN_MARKER: read files before editing them.",
  icon: "coder",
  builtIn: true,
};

const customAgent: Agent = {
  id: "custom-1",
  name: "My Agent",
  description: "A custom persona.",
  instructions: "CUSTOM_MARKER: do the thing.",
  icon: "spark",
  builtIn: false,
};

beforeAll(() => {
  // Radix Dialog leans on a few DOM APIs happy-dom doesn't ship.
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  Element.prototype.scrollIntoView ||= () => {};
  Element.prototype.hasPointerCapture ||= () => false;
  Element.prototype.setPointerCapture ||= () => {};
  Element.prototype.releasePointerCapture ||= () => {};
});

afterEach(cleanup);

describe("AgentCard — tile activation", () => {
  it("activates when the tile body (not a button) is clicked", () => {
    const onActivate = vi.fn();
    const onView = vi.fn();
    render(
      <AgentCard
        agent={builtinAgent}
        active={false}
        onActivate={onActivate}
        onView={onView}
        onEdit={null}
        onDelete={null}
      />,
    );
    // Clicking the name text bubbles up to the card's role="button" handler.
    fireEvent.click(screen.getByText("Coder"));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onView).not.toHaveBeenCalled();
  });

  it("activates on Enter and Space via the keyboard", () => {
    const onActivate = vi.fn();
    const { container } = render(
      <AgentCard
        agent={customAgent}
        active={false}
        onActivate={onActivate}
        onView={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const card = container.querySelector('[role="button"]');
    if (!card) throw new Error("card role=button not found");
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: " " });
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it("does NOT activate when Delete or View is clicked (stopPropagation)", () => {
    const onActivate = vi.fn();
    const onDelete = vi.fn();
    const onView = vi.fn();
    render(
      <AgentCard
        agent={customAgent}
        active={false}
        onActivate={onActivate}
        onView={onView}
        onEdit={vi.fn()}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByTitle("Delete"));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle("View details"));
    expect(onView).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("fires activate exactly once from the Use agent button (no bubble double-fire)", () => {
    const onActivate = vi.fn();
    render(
      <AgentCard
        agent={customAgent}
        active={false}
        onActivate={onActivate}
        onView={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    // Anchored: the card wrapper is also role="button" and its accessible
    // name contains "Use agent" — we want the inner button specifically.
    fireEvent.click(screen.getByRole("button", { name: /^use agent$/i }));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});

describe("AgentDetailsDialog — read-only view", () => {
  it("shows a built-in agent read-only: instructions, note, no inputs, no Edit", () => {
    render(
      <AgentDetailsDialog
        agent={builtinAgent}
        active={false}
        onClose={vi.fn()}
        onActivate={vi.fn()}
        onEdit={null}
      />,
    );
    expect(screen.getByText(/BUILTIN_MARKER/)).toBeTruthy();
    // Read-only: no editable text fields rendered.
    expect(screen.queryByRole("textbox")).toBeNull();
    // The read-only note keys off builtIn.
    expect(screen.getByText(/read-only/i)).toBeTruthy();
    // No Edit affordance for built-in.
    expect(screen.queryByRole("button", { name: /^edit$/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /use this agent/i }),
    ).toBeTruthy();
  });

  it("fires onActivate from the dialog's Use this agent button", () => {
    const onActivate = vi.fn();
    render(
      <AgentDetailsDialog
        agent={builtinAgent}
        active={false}
        onClose={vi.fn()}
        onActivate={onActivate}
        onEdit={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /use this agent/i }));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("disables the activate button and shows Active when already active", () => {
    render(
      <AgentDetailsDialog
        agent={builtinAgent}
        active={true}
        onClose={vi.fn()}
        onActivate={vi.fn()}
        onEdit={null}
      />,
    );
    const btn = screen.getByRole("button", {
      name: /active/i,
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("offers Edit for a custom agent (no read-only note) and hands off", () => {
    const onEdit = vi.fn();
    render(
      <AgentDetailsDialog
        agent={customAgent}
        active={false}
        onClose={vi.fn()}
        onActivate={vi.fn()}
        onEdit={onEdit}
      />,
    );
    expect(screen.queryByText(/read-only/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});
