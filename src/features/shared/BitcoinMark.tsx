interface BitcoinMarkProps {
  className?: string;
}

export function BitcoinMark({ className }: BitcoinMarkProps) {
  const classes =
    className === undefined ? 'btc-mark' : `btc-mark ${className}`;

  return (
    <svg
      className={classes}
      viewBox="0 0 596 1000"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
    >
      <path d="M140.7 140.7V0.0H204.6V140.7ZM292.7 140.7V0.0H357.1V140.7ZM140.7 1000.0V859.3H204.6V1000.0ZM292.7 1000.0V859.3H357.1V1000.0ZM0.0 900.1V99.9H306.1Q392.6 99.9 450.1 127.3Q507.5 154.7 536.0 201.4Q564.4 248.1 564.4 307.7Q564.4 356.6 545.6 391.2Q526.9 425.9 495.4 447.4Q464.0 468.9 424.8 478.0V486.0Q467.2 488.2 506.4 511.8Q545.6 535.4 570.6 578.4Q595.6 621.4 595.6 682.1Q595.6 744.4 565.5 793.8Q535.4 843.2 475.0 871.6Q414.6 900.1 322.8 900.1ZM143.4 780.3H300.2Q379.7 780.3 414.9 749.7Q450.1 719.1 450.1 671.3Q450.1 635.3 432.3 606.6Q414.6 577.9 382.1 561.2Q349.6 544.6 305.0 544.6H143.4ZM143.4 440.9H287.9Q326.0 440.9 356.1 427.0Q386.1 413.0 403.6 387.2Q421.1 361.4 421.1 326.0Q421.1 279.3 388.3 249.2Q355.5 219.1 291.1 219.1H143.4Z" />
    </svg>
  );
}
