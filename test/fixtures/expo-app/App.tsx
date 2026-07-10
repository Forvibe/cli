import React from "react";
import { View, Text, Button } from "react-native";

function signUp(email: string) {
  console.log("signing up", email);
}

export default function App() {
  return (
    <View>
      <Text>Fixture Expo App</Text>
      <Button title="Sign Up" onPress={() => signUp("test@example.com")} />
    </View>
  );
}
