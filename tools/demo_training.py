#!/usr/bin/env python3
"""Fake training run that reports to the Ledge notch, for trying the widget.

    python3 tools/demo_training.py                  # finishes normally
    python3 tools/demo_training.py --crash          # crashes halfway
    python3 tools/demo_training.py --stall          # stops updating halfway
    python3 tools/demo_training.py --epochs 3 --steps 20 --step-time 0.1

No real training happens: the loss is a noisy decaying curve.
"""

import argparse
import math
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ledge_status import RunStatus  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--name", default=f"demo-{random.choice(['resnet', 'gpt-tiny', 'unet', 'vit'])}-{random.randint(100, 999)}")
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--steps", type=int, default=50, help="steps per epoch")
    parser.add_argument("--step-time", type=float, default=0.2, help="seconds per step")
    parser.add_argument("--crash", action="store_true", help="raise an error halfway through")
    parser.add_argument("--stall", action="store_true", help="stop updating halfway and hang")
    args = parser.parse_args()

    total = args.epochs * args.steps
    print(f"Run '{args.name}': {args.epochs} epochs x {args.steps} steps, about {total * args.step_time:.0f}s")
    with RunStatus(args.name, total_epochs=args.epochs, every=5) as status:
        for epoch in range(1, args.epochs + 1):
            for step in range(1, args.steps + 1):
                done = (epoch - 1) * args.steps + step
                if done == total // 2 and args.crash:
                    raise RuntimeError("simulated crash (CUDA out of memory)")
                if done == total // 2 and args.stall:
                    print("Stalling: no more updates. Ctrl+C to stop.")
                    while True:
                        time.sleep(60)
                time.sleep(args.step_time)
                loss = 2.5 * math.exp(-3 * done / total) + 0.05 + random.uniform(-0.03, 0.03)
                status.update(epoch=epoch, step=done, loss=loss, eta_seconds=(total - done) * args.step_time)
            print(f"epoch {epoch}/{args.epochs}  loss {loss:.3f}")
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
