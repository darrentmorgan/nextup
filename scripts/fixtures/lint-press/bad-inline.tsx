<Button onPress={() => save()} />
<Button onPress={async () => save()} />
<Button onPress={function () { save() }} />
<Button onPress={event => save(event)} />
<Button onPress = { (event: Event): void => save(event) } />
