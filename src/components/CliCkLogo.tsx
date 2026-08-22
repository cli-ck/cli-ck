import { cn } from "@/lib/utils";

type Props = {
  className?: string;
  size?: number;
};

export function CliCkLogo({ className, size = 24 }: Props) {
  return (
    <svg
      className={cn("select-none pointer-events-none", className)}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      width={size}
      height={size}
    >
      <rect x="8" y="8" width="84" height="84" rx="22" fill="#10B981" />
      <path
        d="M40 37 L57 50 L40 63"
        fill="none"
        stroke="#04160F"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
