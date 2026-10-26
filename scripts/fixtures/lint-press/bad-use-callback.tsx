const handler = useCallback(() => save(), [])
const other = React.useCallback(function () { save() }, [])
<Button onPress={useCallback(() => save(), [])} />
<Button onPress={React.useCallback(async () => save(), [])} />
<Button onPress={handler} />
<Button onPress={other} />
<Button onPress={ready ? handler : null} />
