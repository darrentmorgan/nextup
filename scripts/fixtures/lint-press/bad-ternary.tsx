<Button onPress={ready ? a : b} />
<Button onPress={ready ? () => save() : view('Back', back)} />
<Button onPress={ready ? act('Save', save) : async () => back()} />
<Button onPress={ready ? function () { save() } : null} />
<Button onPress={(ready ? act('Save', save) : (other ? back : null))} />
<Button onPress={ready ? act('Save', save) : back} />
