import { Graphics, Text } from "@pixi/react";
import type { Graphics as PixiGraphics, TextStyle } from "pixi.js";
import { drawRoundedRect } from "./drawRoundedRect";
import type { ActivityKind } from "../../../../server/activity";

type ActivityBubbleData = {
  show: boolean;
  x: number;
  y: number;
  size: number;
  emoji: string;
  textX: number;
  textY: number;
  activity?: ActivityKind | "approval" | null;
};

type ActivityBubbleProps = {
  bubble: ActivityBubbleData;
  style: TextStyle;
  time: number;
};

export const drawActivityIcon = (
  graphics: PixiGraphics, activity: ActivityKind | "approval", x: number, y: number, time: number
) => {
  const frame = Math.floor(time / 160) % 4;
  const rect = (dx: number, dy: number, width: number, height: number, color: number, alpha = 1) => {
    graphics.beginFill(color, alpha);
    graphics.drawRect(x + dx, y + dy, width, height);
    graphics.endFill();
  };
  graphics.lineStyle(0);
  if (activity === "approval") {
    rect(10, 4, 4, 11, 0xb91c1c);
    rect(10, 18, 4, 4, 0xb91c1c);
  } else if (activity === "writing") {
    rect(3, 2, 18, 11, 0x334155);
    rect(5, 4, 14, 7, 0xdbeafe);
    rect(6, 5, 3 + frame * 3, 2, 0x2563eb);
    rect(6 + frame * 3, 8, 2, 2, 0x2563eb);
    rect(2, 15, 20, 7, 0x475569);
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 5; col++) rect(4 + col * 3, 16 + row * 3, 2, 2, 0xe2e8f0);
    }
    rect(frame % 2 ? 5 : 12, 14, 5, 3, 0xf2c9a0);
  } else if (activity === "reading") {
    rect(1, 4, 22, 17, 0x854d0e);
    rect(2, 3, 9, 16, 0xfffbeb);
    rect(13, 3, 9, 16, 0xfffbeb);
    rect(11, 4, 2, 17, 0xd6a864);
    for (let row = 0; row < 4; row++) {
      rect(4, 6 + row * 3, 5, 1, 0x94a3b8);
      rect(15, 6 + row * 3, 5, 1, 0x94a3b8);
    }
    rect(frame < 2 ? 3 : 14, 6 + frame % 2 * 6, 7, 2, 0xd6a864);
  } else if (activity === "research") {
    rect(1, 2, 22, 20, 0x334155);
    rect(3, 4, 18, 3, 0x93c5fd);
    rect(3, 8, 18, 12, 0xeff6ff);
    graphics.lineStyle(1, 0x2563eb);
    graphics.drawCircle(x + 12, y + 14, 5);
    graphics.drawEllipse(x + 12, y + 14, 2, 5);
    graphics.moveTo(x + 7, y + 14);
    graphics.lineTo(x + 17, y + 14);
    graphics.lineStyle(0);
    rect(4 + frame * 4, 5, 3, 1, 0xffffff);
  } else {
    rect(1, 2, 22, 17, 0x334155);
    rect(3, 4, 18, 13, 0x052e16);
    for (let row = 0; row < 3; row++) {
      rect(5, 6 + row * 3, 4 + (frame + row) % 4 * 2, 1, 0x4ade80, frame % 2 ? 0.65 : 1);
    }
    rect(5 + frame * 3, 14, 3, 2, 0x86efac);
    rect(10, 19, 4, 2, 0x475569);
    rect(6, 21, 12, 2, 0x475569);
  }
};

const ActivityBubble = ({ bubble, style, time }: ActivityBubbleProps) => (
  <>
    <Graphics
      draw={(graphics: PixiGraphics) => {
        graphics.clear();
        if (!bubble.show) {
          return;
        }
        drawRoundedRect(
          graphics,
          bubble.x,
          bubble.y,
          bubble.size,
          bubble.size,
          6,
          bubble.activity === "approval" ? 0xfff1f2 : 0xf1f3ff,
          bubble.activity === "approval" ? 0xb91c1c : 0x5a6aa0,
          1
        );
        if (bubble.activity) {
          drawActivityIcon(graphics, bubble.activity, bubble.x + 3, bubble.y + 3, time);
        }
      }}
    />
    {bubble.show && !bubble.activity && (
      <Text text={bubble.emoji} x={bubble.textX} y={bubble.textY} style={style} />
    )}
  </>
);

export { ActivityBubble };
export type { ActivityBubbleData };
