// Magic UI Safari (registry: safari), static SVG frame. Render without a client: directive.
// Adapted: the screen area takes `children` (our lazy video) instead of videoSrc/imageSrc,
// and SVG ids are unique per instance.
import { useId, type HTMLAttributes, type ReactNode } from "react";

const SAFARI_WIDTH = 1203;
const SAFARI_HEIGHT = 753;
const SCREEN_X = 1;
const SCREEN_Y = 52;
const SCREEN_WIDTH = 1200;
const SCREEN_HEIGHT = 700;

const LEFT_PCT = (SCREEN_X / SAFARI_WIDTH) * 100;
const TOP_PCT = (SCREEN_Y / SAFARI_HEIGHT) * 100;
const WIDTH_PCT = (SCREEN_WIDTH / SAFARI_WIDTH) * 100;
const HEIGHT_PCT = (SCREEN_HEIGHT / SAFARI_HEIGHT) * 100;

export interface SafariProps extends HTMLAttributes<HTMLDivElement> {
  url?: string;
  children?: ReactNode;
}

export function Safari({ url, className, style, children, ...props }: SafariProps) {
  const uid = useId().replace(/:/g, "");
  const hasMedia = !!children;

  return (
    <div
      className={`relative inline-block w-full align-middle leading-none ${className ?? ""}`}
      style={{ aspectRatio: `${SAFARI_WIDTH}/${SAFARI_HEIGHT}`, ...style }}
      {...props}
    >
      {hasMedia && (
        <div
          className="absolute z-0 overflow-hidden"
          style={{
            left: `${LEFT_PCT}%`,
            top: `${TOP_PCT}%`,
            width: `${WIDTH_PCT}%`,
            height: `${HEIGHT_PCT}%`,
            borderRadius: "0 0 11px 11px",
          }}
        >
          {children}
        </div>
      )}

      <svg
        viewBox={`0 0 ${SAFARI_WIDTH} ${SAFARI_HEIGHT}`}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-10 size-full"
        style={{ transform: "translateZ(0)" }}
      >
        <defs>
          <mask id={`${uid}-punch`} maskUnits="userSpaceOnUse">
            <rect x="0" y="0" width={SAFARI_WIDTH} height={SAFARI_HEIGHT} fill="white" />
            <path d="M1 52H1201V741C1201 747.075 1196.08 752 1190 752H12C5.92486 752 1 747.075 1 741V52Z" fill="black" />
          </mask>
          <clipPath id={`${uid}-clip`}>
            <rect width={SAFARI_WIDTH} height={SAFARI_HEIGHT} fill="white" />
          </clipPath>
        </defs>

        <g clipPath={`url(#${uid}-clip)`} mask={hasMedia ? `url(#${uid}-punch)` : undefined}>
          <path
            d="M0 52H1202V741C1202 747.627 1196.63 753 1190 753H12C5.37258 753 0 747.627 0 741V52Z"
            className="fill-[#E5E5E5] dark:fill-[#404040]"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M0 12C0 5.37258 5.37258 0 12 0H1190C1196.63 0 1202 5.37258 1202 12V52H0L0 12Z"
            className="fill-[#E5E5E5] dark:fill-[#404040]"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M1.06738 12C1.06738 5.92487 5.99225 1 12.0674 1H1189.93C1196.01 1 1200.93 5.92487 1200.93 12V51H1.06738V12Z"
            className="fill-white dark:fill-[#262626]"
          />
          <circle cx="27" cy="25" r="6" className="fill-[#ff5f57]" />
          <circle cx="47" cy="25" r="6" className="fill-[#febc2e]" />
          <circle cx="67" cy="25" r="6" className="fill-[#28c840]" />
          <path
            d="M286 17C286 13.6863 288.686 11 292 11H946C949.314 11 952 13.6863 952 17V35C952 38.3137 949.314 41 946 41H292C288.686 41 286 38.3137 286 35V17Z"
            className="fill-[#E5E5E5] dark:fill-[#404040]"
          />
          <g className="mix-blend-luminosity">
            <path
              d="M566.269 32.0852H572.426C573.277 32.0852 573.696 31.6663 573.696 30.7395V25.9851C573.696 25.1472 573.353 24.7219 572.642 24.6521V23.0842C572.642 20.6721 571.036 19.5105 569.348 19.5105C567.659 19.5105 566.053 20.6721 566.053 23.0842V24.6711C565.393 24.7727 565 25.1917 565 25.9851V30.7395C565 31.6663 565.418 32.0852 566.269 32.0852ZM567.272 22.97C567.272 21.491 568.211 20.6785 569.348 20.6785C570.478 20.6785 571.423 21.491 571.423 22.97V24.6394L567.272 24.6458V22.97Z"
              fill="#A3A3A3"
            />
          </g>
          <g className="mix-blend-luminosity">
            <text x="580" y="30" fill="#A3A3A3" fontSize="12" fontFamily="Arial, sans-serif">
              {url}
            </text>
          </g>
          <g className="mix-blend-luminosity">
            <path
              d="M143.914 32.5938C144.094 32.7656 144.312 32.8594 144.562 32.8594C145.086 32.8594 145.492 32.4531 145.492 31.9375C145.492 31.6797 145.391 31.4453 145.211 31.2656L139.742 25.9219L145.211 20.5938C145.391 20.4141 145.492 20.1719 145.492 19.9219C145.492 19.4062 145.086 19 144.562 19C144.312 19 144.094 19.0938 143.922 19.2656L137.844 25.2031C137.625 25.4062 137.516 25.6562 137.516 25.9297C137.516 26.2031 137.625 26.4375 137.836 26.6484L143.914 32.5938Z"
              fill="#A3A3A3"
            />
          </g>
          <g className="mix-blend-luminosity">
            <path
              d="M168.422 32.8594C168.68 32.8594 168.891 32.7656 169.07 32.5938L175.148 26.6562C175.359 26.4375 175.469 26.2109 175.469 25.9297C175.469 25.6562 175.367 25.4141 175.148 25.2109L169.07 19.2656C168.891 19.0938 168.68 19 168.422 19C167.898 19 167.492 19.4062 167.492 19.9219C167.492 20.1719 167.602 20.4141 167.773 20.5938L173.25 25.9375L167.773 31.2656C167.594 31.4531 167.492 31.6797 167.492 31.9375C167.492 32.4531 167.898 32.8594 168.422 32.8594Z"
              fill="#A3A3A3"
            />
          </g>
          <g className="mix-blend-luminosity">
            <path
              d="M1134 33.0156C1134.49 33.0156 1134.89 32.6094 1134.89 32.1484V27.2578H1139.66C1140.13 27.2578 1140.54 26.8594 1140.54 26.3672C1140.54 25.8828 1140.13 25.4766 1139.66 25.4766H1134.89V20.5859C1134.89 20.1172 1134.49 19.7188 1134 19.7188C1133.52 19.7188 1133.11 20.1172 1133.11 20.5859V25.4766H1128.34C1127.88 25.4766 1127.46 25.8828 1127.46 26.3672C1127.46 26.8594 1127.88 27.2578 1128.34 27.2578H1133.11V32.1484C1133.11 32.6094 1133.52 33.0156 1134 33.0156Z"
              fill="#A3A3A3"
            />
          </g>
        </g>
      </svg>
    </div>
  );
}
