import { Graphics, Text } from "@pixi/react";
import type { Graphics as PixiGraphics, TextStyle } from "pixi.js";
import { drawRoundedRect } from "./drawRoundedRect";

type MessageBubbleData = {
  show: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  textX: number;
  textY: number;
  lines: string[];
  approval?: boolean;
};

type MessageBubbleProps = {
  bubble: MessageBubbleData;
  style: TextStyle;
};

const MessageBubble = ({ bubble, style }: MessageBubbleProps) => (
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
          bubble.width,
          bubble.height,
          4,
          bubble.approval ? 0xfff1f2 : 0xf1fff3,
          bubble.approval ? 0xb91c1c : 0x3a5b3c,
          1.5
        );
        if (bubble.approval) {
          graphics.beginFill(0xfff1f2);
          graphics.moveTo(bubble.x + bubble.width / 2 - 3, bubble.y + bubble.height);
          graphics.lineTo(bubble.x + bubble.width / 2, bubble.y + bubble.height + 4);
          graphics.lineTo(bubble.x + bubble.width / 2 + 3, bubble.y + bubble.height);
          graphics.endFill();
        }
      }}
    />
    {bubble.show && (
      <Text
        text={bubble.lines.join("\n")}
        x={bubble.textX}
        y={bubble.textY}
        style={style}
      />
    )}
  </>
);

export { MessageBubble };
export type { MessageBubbleData };
