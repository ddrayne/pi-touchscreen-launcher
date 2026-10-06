import { memo } from "react";
import type { SilhouetteId } from "../../lib/frame/archetypes.ts";
import { isOverhead, silhouetteShapes, type Pose, type Shape } from "./silhouettes.ts";

function Shapes({ shapes }: { shapes: Shape[] }) {
  return (
    <>
      {shapes.map((shape, index) => {
        switch (shape.kind) {
          case "ellipse":
            return (
              <ellipse
                key={index}
                cx={shape.cx}
                cy={shape.cy}
                rx={shape.rx}
                ry={shape.ry}
                transform={`rotate(${shape.rotate} ${shape.cx} ${shape.cy})`}
              />
            );
          case "circle":
            return <circle key={index} cx={shape.cx} cy={shape.cy} r={shape.r} />;
          case "path":
            return <path key={index} d={shape.d} />;
          case "line":
            return (
              <line
                key={index}
                x1={shape.x1}
                y1={shape.y1}
                x2={shape.x2}
                y2={shape.y2}
                strokeWidth={shape.width}
                strokeLinecap="round"
              />
            );
          default:
            return null;
        }
      })}
    </>
  );
}

type SilhouetteProps = {
  id: SilhouetteId;
  /** Flying birds cycle their wing frames; perched birds show one pose. */
  flying: boolean;
  /** Soaring birds hold a glide instead of flapping. */
  gliding?: boolean;
};

export const Silhouette = memo(function Silhouette({ id, flying, gliding }: SilhouetteProps) {
  const overhead = isOverhead(id);
  const poses: Pose[] = flying
    ? gliding
      ? ["glide"]
      : overhead
        ? ["glide", "up", "mid", "down"]
        : ["up", "mid", "down", "mid"]
    : [overhead ? "glide" : "perched"];
  return (
    <svg className="frame-body__svg" viewBox="0 0 100 100" aria-hidden="true">
      {poses.map((pose, index) => (
        <g
          key={`${pose}-${index}`}
          className={poses.length > 1 ? `frame-body__pose frame-body__pose--${index + 1}` : undefined}
        >
          <Shapes shapes={silhouetteShapes(id, pose)} />
        </g>
      ))}
    </svg>
  );
});
