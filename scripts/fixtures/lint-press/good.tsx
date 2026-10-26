const handler = useCallback(() => save(), [])
<Button onPress={act('Save', () => save())} />
<Button onPress={view('Back', function () { back() })} />
<Button onPress={ready ? act('Save', save) : view('Back', back)} />
<Button onPress={(ready ? (act('Save', save)) : null)} />
<Button onPress={ready ? act('Save', save) : other ? view('Back', back) : undefined} />
<Button onPress={act('Save', handler)} />
<Button onPress={existingHandler} />
<Button onPress={undefined} />
// <Button onPress={() => save()} />
/* <Button onPress={ready ? a : b} /> */
const example = 'onPress={() => save()}'
<Button label="onPress={() => save()}" onPress={view('Back', back)} />
<Button onPress={act('Save', useCallback(() => save(), []))} />
