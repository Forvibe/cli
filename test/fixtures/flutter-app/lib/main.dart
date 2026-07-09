import 'package:flutter/material.dart';

void main() {
  runApp(const FixtureApp());
}

class FixtureApp extends StatelessWidget {
  const FixtureApp({super.key});

  Future<void> restorePurchases() async {
    // Fixture placeholder for IAP restore flow.
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        body: TextButton(
          onPressed: () => restorePurchases(),
          child: const Text("Restore purchases"),
        ),
      ),
    );
  }
}
