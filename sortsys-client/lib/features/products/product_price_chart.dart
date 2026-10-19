import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import 'product_price_history.dart';

const productPriceGreen = Color(0xff43a047);

class ProductPriceChart extends StatefulWidget {
  const ProductPriceChart({
    super.key,
    required this.records,
    required this.baseUnit,
  });

  final List<ProductPriceRecord> records;
  final String baseUnit;

  @override
  State<ProductPriceChart> createState() {
    return _ProductPriceChartState();
  }
}

class _ProductPriceChartState extends State<ProductPriceChart> {
  int? _active;

  @override
  Widget build(BuildContext context) {
    final records = widget.records.reversed.toList();
    final german = Localizations.localeOf(context).languageCode == 'de';
    final dates = DateFormat(german ? 'dd.MM.yyyy' : 'dd/MM/yyyy');
    final currency = NumberFormat.currency(
      locale: german ? 'de_DE' : 'en_GB',
      name: 'EUR',
      symbol: '€',
      decimalDigits: 2,
    );

    return SizedBox(
      height: 150,
      child: LayoutBuilder(
        builder: (context, constraints) {
          void select(Offset position) {
            if (records.isEmpty) {
              return;
            }

            final width = math.max(1.0, constraints.maxWidth - 16);
            final fraction = ((position.dx - 8) / width).clamp(0.0, 1.0);
            final index = (fraction * (records.length - 1)).round();

            setState(() {
              _active = index;
            });
          }

          final active = _active;
          final record = active != null && active < records.length
              ? records[active]
              : null;

          return Semantics(
            label: german ? 'Preisentwicklung' : 'Price history',
            child: MouseRegion(
              onHover: (event) {
                select(event.localPosition);
              },
              onExit: (event) {
                setState(() {
                  _active = null;
                });
              },
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTapDown: (details) {
                  select(details.localPosition);
                },
                onPanUpdate: (details) {
                  select(details.localPosition);
                },
                child: Stack(
                  children: [
                    Positioned.fill(
                      child: CustomPaint(
                        painter: ProductPricePainter(
                          prices: [for (final item in records) item.price],
                          active: record == null ? null : active,
                          gridColor: SsTheme.of(context).border,
                        ),
                      ),
                    ),
                    if (record != null)
                      Positioned(
                        left: 8,
                        top: 8,
                        right: 8,
                        child: Align(
                          alignment: Alignment.topLeft,
                          child: Container(
                            padding: const EdgeInsets.all(10),
                            decoration: BoxDecoration(
                              color: SsTheme.of(context).surface,
                              borderRadius: BorderRadius.circular(10),
                              border: Border.all(
                                color: const Color(0x14000000),
                              ),
                            ),
                            child: Text(
                              '${dates.format(record.timestamp.toLocal())}\n'
                              'Preis : ${currency.format(record.price)} / '
                              '${widget.baseUnit}',
                              style: SsTheme.of(context).body,
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

class ProductPricePainter extends CustomPainter {
  ProductPricePainter({
    required this.prices,
    required this.gridColor,
    this.active,
  });

  final List<num> prices;
  final Color gridColor;
  final int? active;

  List<Offset> points(Size size) {
    if (prices.isEmpty || size.width <= 16 || size.height <= 8) {
      return const [];
    }

    final low = prices.reduce(math.min).toDouble() * 0.6;
    final high = prices.reduce(math.max).toDouble() * 1.2;
    final range = high == low ? 1.0 : high - low;
    final width = size.width - 16;
    final height = size.height - 8;

    return [
      for (var index = 0; index < prices.length; index++)
        Offset(
          prices.length == 1
              ? size.width / 2
              : 8 + width * index / (prices.length - 1),
          8 + height * (1 - (prices[index] - low) / range),
        ),
    ];
  }

  @override
  void paint(Canvas canvas, Size size) {
    final positions = points(size);

    if (positions.isEmpty) {
      return;
    }

    canvas.save();
    canvas.clipRect(Offset.zero & size);

    final grid = Paint()
      ..color = gridColor.withValues(alpha: 0.8)
      ..strokeWidth = 1;

    for (var row = 0; row < 5; row++) {
      final y = 8 + (size.height - 8) * row / 4;

      for (var x = 8.0; x < size.width - 8; x += 9) {
        canvas.drawLine(
          Offset(x, y),
          Offset(math.min(x + 3, size.width - 8), y),
          grid,
        );
      }
    }

    final line = Path()..moveTo(positions.first.dx, positions.first.dy);

    for (final position in positions.skip(1)) {
      line.lineTo(position.dx, position.dy);
    }

    final area = Path.from(line)
      ..lineTo(positions.last.dx, size.height)
      ..lineTo(positions.first.dx, size.height)
      ..close();
    final fill = Paint()
      ..shader = LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [
          productPriceGreen.withValues(alpha: 0.25),
          productPriceGreen.withValues(alpha: 0.02),
        ],
      ).createShader(Offset.zero & size);

    canvas.drawPath(area, fill);
    canvas.drawPath(
      line,
      Paint()
        ..color = productPriceGreen
        ..strokeWidth = 2
        ..style = PaintingStyle.stroke,
    );

    final selected = active;

    if (selected != null && selected >= 0 && selected < positions.length) {
      canvas.drawCircle(
        positions[selected],
        4,
        Paint()..color = productPriceGreen,
      );
    }

    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant ProductPricePainter oldDelegate) {
    return oldDelegate.prices != prices ||
        oldDelegate.active != active ||
        oldDelegate.gridColor != gridColor;
  }
}
